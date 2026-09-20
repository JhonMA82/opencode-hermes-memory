/**
 * Hermes Memory for OpenCode V2 — plugin entry.
 *
 * Native V2 implementation (OpenCode >= 2.0):
 *   - `Plugin.define({ id, setup })` from `@opencode/plugin`
 *   - Tools via `ctx.tool.transform`
 *   - Prompt admission via `ctx.session.hook("prompt")` (correction detection,
 *     turn counting, relevant-memory auto-injection)
 *   - System injection via `ctx.session.hook("context")` (policy + STANDING +
 *     project memory)
 *   - Flush review via `ctx.session.hook("compaction")`
 *   - Error prefetch via `ctx.tool.hook("execute.after")` (bash failures)
 *   - Background learning via `ctx.event.subscribe()` (session.idle)
 *   - LLM via `ctx.generate.text()` (no internal sessions)
 *
 * Layers:
 *   L0 STANDING.md   — hard instructions, injected every model request
 *   L1 Markdown truth — USER.md / MEMORY.md / failures.md / projects-memory/<id>/MEMORY.md
 *   L2 retrieval     — memory_search tool over the Markdown layers
 *   Learning loop    — background review on idle (generate.text, debounced),
 *                      correction detection on prompt (rule-based),
 *                      flush review on compaction,
 *                      auto-consolidation when a target hits capacity
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { Plugin } from "@opencode/plugin";
import {
  clearSession,
  clearSessionState,
  consolidateTargetV2,
  detectCorrection,
  runBackgroundReviewV2,
  runFlushReviewV2,
  setDebugLogger,
} from "./hermes-memory-lib/learn.ts";
import { historyFile } from "./hermes-memory-lib/paths.ts";
import {
  DEFAULT_NUDGE_INTERVAL,
  MEMORY_ADD_TOOL_DESCRIPTION,
  MEMORY_POLICY_PROMPT,
  MEMORY_SEARCH_TOOL_DESCRIPTION,
} from "./hermes-memory-lib/prompts.ts";
import { searchMemories } from "./hermes-memory-lib/search.ts";
import { type MemoryCategory, MemoryStore, splitEntries, type Target } from "./hermes-memory-lib/store.ts";

const LOG_FILE = path.join(process.env.HOME ?? ".", ".local", "share", "opencode", "log", "hermes-memory.log");
const LOG_MAX_BYTES = 1 * 1024 * 1024;
const LOG_ROTATE_CHECK_INTERVAL_MS = 30_000;

function nudgeIntervalFromEnvAndOptions(options: Record<string, unknown>): number {
  const fromOptions = Number((options as { hermesNudgeInterval?: unknown }).hermesNudgeInterval);
  if (Number.isFinite(fromOptions) && fromOptions > 0) return Math.floor(fromOptions);
  return Number(process.env.HERMES_NUDGE_INTERVAL) || DEFAULT_NUDGE_INTERVAL;
}

const IDLE_DEBOUNCE_MS = 10_000;

let lastRotateCheckAt = 0;
function rotateLog(): void {
  const now = Date.now();
  if (now - lastRotateCheckAt < LOG_ROTATE_CHECK_INTERVAL_MS) return;
  lastRotateCheckAt = now;
  try {
    let stat: ReturnType<typeof fs.statSync> | undefined;
    try {
      stat = fs.statSync(LOG_FILE);
    } catch {
      return;
    }
    if (!stat.isFile() || stat.size < LOG_MAX_BYTES) return;
    fs.rmSync(`${LOG_FILE}.2`, { force: true });
    if (fs.existsSync(`${LOG_FILE}.1`)) fs.renameSync(`${LOG_FILE}.1`, `${LOG_FILE}.2`);
    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch {
    /* ignore */
  }
}

function log(msg: string): void {
  try {
    rotateLog();
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* ignore */
  }
}

function projectIdOf(project: { id?: string } | undefined, directory: string): string {
  if (project?.id) return project.id;
  return path.basename(directory) || "default";
}

// ─── Bash error detection (for failure-memory prefetch) ───
const BASH_ERROR_PATTERNS: RegExp[] = [
  /command not found/i,
  /no such file or directory/i,
  /permission denied/i,
  /not found/i,
  /failed to/i,
  /error:/i,
  /fatal:/i,
  /cannot find/i,
  /unable to/i,
  /is not recognized/i,
  /exit code [1-9]\d*/i,
  /exited with code [1-9]\d*/i,
  /syntax error/i,
  /undefined/i,
  /traceback/i,
  /exception/i,
  /npm err/i,
  /tsc error/i,
  /bun error/i,
  /panic:/i,
  /segmentation fault/i,
  /killed/i,
  /no space left/i,
  /connection refused/i,
  /timed? out/i,
  /econnrefused/i,
  /eacces/i,
  /enoent/i,
  /eexist/i,
];

function looksLikeBashError(text: string): boolean {
  const sample = text.slice(0, 4000);
  return BASH_ERROR_PATTERNS.some((re) => re.test(sample));
}

function extractErrorSnippet(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const errLines = lines.filter((l) => BASH_ERROR_PATTERNS.some((re) => re.test(l)));
  const picked = (errLines.length ? errLines : lines).slice(0, 3);
  return picked.join(" ").slice(0, 200);
}

/** Extract readable text from a V2 tool-after event (handles several shapes). */
function extractToolResultText(event: {
  status?: string;
  result?: unknown;
  error?: unknown;
  output?: unknown;
}): string {
  if (event.status === "error") {
    const err = event.error as { message?: unknown; data?: unknown } | undefined;
    if (typeof err?.message === "string") return err.message;
    return JSON.stringify(err ?? "");
  }
  const result = event.result as
    | { content?: string | Array<{ type?: string; text?: string }>; output?: unknown; text?: unknown }
    | string
    | undefined;
  if (typeof result === "string") return result;
  if (typeof result?.content === "string") return result.content;
  if (Array.isArray(result?.content)) {
    return result.content
      .filter((c) => c?.type === "text" && typeof c.text === "string")
      .map((c) => (c as { text: string }).text)
      .join("\n");
  }
  if (typeof result?.output === "string") return result.output;
  if (typeof result?.text === "string") return result.text;
  if (typeof event.output === "string") return event.output;
  return "";
}

const TARGETS = ["memory", "user", "failure", "project"] as const;
const CATEGORIES = ["failure", "correction", "insight", "preference", "convention", "tool-quirk"] as const;

type ToolInput = Record<string, unknown>;

export default Plugin.define({
  id: "hermes-memory",
  async setup(ctx) {
    try {
      fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    } catch {
      /* ignore */
    }

    const directory = ctx.location.directory;
    const currentProject = projectIdOf(
      ctx.location.project as { id?: string } | undefined,
      directory,
    );
    const NUDGE_INTERVAL = nudgeIntervalFromEnvAndOptions(ctx.options as Record<string, unknown>);

    const store = new MemoryStore({});
    await store.loadFromDisk().catch((err) => log(`store load failed: ${String(err)}`));

    store.setConsolidator((target, _signal, projectId) =>
      consolidateTargetV2(ctx.generate, store, target, projectId),
    );
    setDebugLogger((msg) => log(msg));

    const sessionTurns = new Map<string, number>();
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let lastIdleSession: string | null = null;
    let lastReviewAt = 0;
    const REVIEW_MIN_INTERVAL_MS = 30 * 60 * 1000;
    const lastPrefetchAt = new Map<string, number>();
    const PREFETCH_MIN_INTERVAL_MS = 60 * 1000;
    const injectedThisSession = new Map<string, Set<string>>();
    const MAX_INJECT_PER_TURN = 2;
    const INJECT_SCORE_THRESHOLD = 0.4;

    const controller = new AbortController();

    log(`initialized v2 (project=${currentProject}, dir=${directory})`);

    // ─── Tools ───
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "memory_search",
        description: MEMORY_SEARCH_TOOL_DESCRIPTION,
        input: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search terms (concrete words work best)." },
            target: { type: "string", enum: [...TARGETS], description: "Which memory layer to search. Omit to search all." },
            category: {
              type: "string",
              enum: [...CATEGORIES],
              description: "Only for target=failure: lesson category.",
            },
            project: { type: "string", description: "Project scope for project memories (defaults to current project)." },
            limit: { type: "number", description: "Max results (default 10)." },
          },
          required: ["query"],
          additionalProperties: false,
        },
        async execute(input) {
          const args = input as {
            query: string;
            target?: Target | "project";
            category?: MemoryCategory;
            project?: string;
            limit?: number;
          };
          const project = args.target === "project" || !args.target ? args.project || currentProject : undefined;
          const hits = searchMemories(store, {
            query: args.query,
            target: args.target,
            category: args.category,
            project,
            limit: Math.max(1, Math.min(Math.floor(args.limit ?? 10), 50)),
          });
          return {
            content: JSON.stringify({
              success: true,
              query: args.query,
              count: hits.length,
              results: hits.map((h) => ({
                target: h.target,
                project: h.project ?? null,
                score: Math.round(h.score * 100),
                content: h.content,
              })),
            }),
          };
        },
      });

      editor.add({
        name: "memory_add",
        description: MEMORY_ADD_TOOL_DESCRIPTION,
        input: {
          type: "object",
          properties: {
            content: { type: "string", description: "The durable fact to remember." },
            target: {
              type: "string",
              enum: [...TARGETS],
              description: "user=profile, memory=global notes, project=repo-specific, failure=categorized lesson.",
            },
            category: { type: "string", enum: [...CATEGORIES], description: "Required for target=failure." },
            failure_reason: { type: "string", description: "Optional context for failure entries." },
            project: {
              type: "string",
              description:
                "Project name when target=project (defaults to current project); also used to scope failure entries.",
            },
          },
          required: ["content", "target"],
          additionalProperties: false,
        },
        async execute(input) {
          const args = input as {
            content: string;
            target: Target | "project";
            category?: MemoryCategory;
            failure_reason?: string;
            project?: string;
          };
          if (args.target === "project") {
            const project = args.project || currentProject;
            const r = await store.addToProject(project, args.content);
            log(`memory_add project=${project} success=${r.success} err=${r.error ?? ""}`);
            return {
              content: JSON.stringify({
                success: r.success,
                message: r.message,
                error: r.error,
                usage: r.usage,
                entry_count: r.entry_count,
              }),
            };
          }
          const target = args.target as Target;
          if (target === "failure" && !args.category) {
            return {
              content: JSON.stringify({ success: false, error: "category is required for target=failure." }),
            };
          }
          const r =
            target === "failure" && args.category
              ? await store.addFailure(args.content, {
                  category: args.category,
                  failureReason: args.failure_reason,
                  project: args.project || currentProject,
                })
              : await store.add(target, args.content);
          log(`memory_add target=${target} success=${r.success} err=${r.error ?? ""}`);
          return {
            content: JSON.stringify({
              success: r.success,
              message: r.message,
              error: r.error,
              usage: r.usage,
              entry_count: r.entry_count,
            }),
          };
        },
      });

      editor.add({
        name: "memory_replace",
        description:
          "Replace an existing memory entry. old_text is matched exactly first (the full entry text or its [category] prefix), falling back to substring if no exact match. The old version is kept in evolution history (readable via memory_history).",
        input: {
          type: "object",
          properties: {
            target: { type: "string", enum: [...TARGETS], description: "Which layer the entry lives in." },
            old_text: { type: "string", description: "Entry text to match (exact match preferred, substring fallback)." },
            content: { type: "string", description: "New entry text." },
            project: { type: "string", description: "Project name when target=project." },
          },
          required: ["target", "old_text", "content"],
          additionalProperties: false,
        },
        async execute(input) {
          const args = input as { target: Target | "project"; old_text: string; content: string; project?: string };
          if (args.target === "project") {
            const r = await store.replaceProjectEntry(args.project || currentProject, args.old_text, args.content);
            return {
              content: JSON.stringify({ success: r.success, message: r.message, error: r.error, matches: r.matches ?? null }),
            };
          }
          const r = await store.replace(args.target as Target, args.old_text, args.content);
          return {
            content: JSON.stringify({ success: r.success, message: r.message, error: r.error, matches: r.matches ?? null }),
          };
        },
      });

      editor.add({
        name: "memory_remove",
        description:
          "Remove a memory entry. old_text is matched exactly first (the full entry text or its [category] prefix), falling back to substring if no exact match.",
        input: {
          type: "object",
          properties: {
            target: { type: "string", enum: [...TARGETS], description: "Which layer the entry lives in." },
            old_text: { type: "string", description: "Entry text to match (exact match preferred, substring fallback)." },
            project: { type: "string", description: "Project name when target=project." },
          },
          required: ["target", "old_text"],
          additionalProperties: false,
        },
        async execute(input) {
          const args = input as { target: Target | "project"; old_text: string; project?: string };
          if (args.target === "project") {
            const r = await store.removeProjectEntry(args.project || currentProject, args.old_text);
            return {
              content: JSON.stringify({ success: r.success, message: r.message, error: r.error, matches: r.matches ?? null }),
            };
          }
          const r = await store.remove(args.target as Target, args.old_text);
          return {
            content: JSON.stringify({ success: r.success, message: r.message, error: r.error, matches: r.matches ?? null }),
          };
        },
      });

      editor.add({
        name: "memory_history",
        description:
          "Read the evolution history of replaced memory entries (superseded versions kept by memory_replace). Use when you need to trace how a fact was configured before, or what an entry looked like before it was replaced. Read-only.",
        input: {
          type: "object",
          properties: {
            query: { type: "string", description: "Optional substring to filter history entries by." },
            limit: { type: "number", description: "Max entries to return (default 20)." },
          },
          additionalProperties: false,
        },
        async execute(input) {
          const args = input as { query?: string; limit?: number };
          let raw: string;
          try {
            raw = await fsp.readFile(historyFile(), "utf-8");
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") raw = "";
            else return { content: JSON.stringify({ success: false, error: String(err) }) };
          }
          try {
            const entries = raw ? splitEntries(raw) : [];
            const query = args.query ?? "";
            const filtered = query ? entries.filter((e) => e.includes(query)) : entries;
            const limit = Math.max(1, Math.min(Math.floor(args.limit ?? 20), 50));
            const picked = filtered.slice(-limit);
            return {
              content: JSON.stringify({
                success: true,
                count: picked.length,
                total: entries.length,
                entries: picked.map((e) => {
                  const meta = store.getEntryMeta(e);
                  return {
                    content: meta.text,
                    created: meta.created,
                    lastReferenced: meta.lastReferenced,
                    superseded: meta.superseded,
                    supersedes: meta.supersedes,
                  };
                }),
              }),
            };
          } catch (err) {
            return { content: JSON.stringify({ success: false, error: String(err) }) };
          }
        },
      });
    });

    // ─── L0 + policy injection into every model request ───
    await ctx.session.hook("context", (event) => {
      try {
        event.system.push({ type: "text", text: MEMORY_POLICY_PROMPT });
        const standing = store.formatStandingForPrompt();
        if (standing) event.system.push({ type: "text", text: standing });
        const projectBlock = store.formatProjectBlock(currentProject);
        if (projectBlock) event.system.push({ type: "text", text: projectBlock });
      } catch (err) {
        log(`context hook error: ${String(err)}`);
      }
    });

    // ─── Correction detection + turn counting + auto-injection ───
    await ctx.session.hook("prompt", async (event) => {
      try {
        const userText = (event.prompt.text ?? "").trim();
        if (!userText) return;

        const turns = (sessionTurns.get(event.sessionID) ?? 0) + 1;
        sessionTurns.set(event.sessionID, turns);

        const match = detectCorrection(userText);
        if (match.matched) {
          const snippet = userText.split("\n")[0].trim().slice(0, 300);
          await store.addFailure(snippet, { category: "correction", project: currentProject });
          log(`correction saved (${match.reason}): ${snippet.slice(0, 80)}`);
        }

        try {
          const hits = searchMemories(store, { query: userText, limit: 8 });
          const fresh = hits.filter((h) => h.score >= INJECT_SCORE_THRESHOLD);
          if (fresh.length > 0) {
            const injected = injectedThisSession.get(event.sessionID) ?? new Set<string>();
            const toInject = fresh
              .filter((h) => !injected.has(h.content.slice(0, 60)))
              .slice(0, MAX_INJECT_PER_TURN);
            if (toInject.length > 0) {
              const block = store.fenceBlock(
                toInject
                  .map((h) => `• [${h.target}${h.project ? `:${h.project}` : ""}] ${h.content.slice(0, 400)}`)
                  .join("\n"),
              );
              await ctx.session
                .synthetic({ sessionID: event.sessionID, text: block })
                .catch((err: unknown) => log(`memory auto-inject failed: ${String(err)}`));
              for (const h of toInject) injected.add(h.content.slice(0, 60));
              injectedThisSession.set(event.sessionID, injected);
              log(
                `memory auto-inject: ${toInject.length} hit(s) (scores=${toInject.map((h) => h.score.toFixed(1)).join(",")})`,
              );
            }
          }
        } catch (err) {
          log(`memory auto-inject error: ${String(err)}`);
        }
      } catch (err) {
        log(`prompt hook error: ${String(err)}`);
      }
    });

    // ─── Flush review on compaction ───
    await ctx.session.hook("compaction", async (event) => {
      try {
        const result = await runFlushReviewV2(ctx.session, ctx.generate, store, currentProject, event.sessionID);
        log(`flush review: saved=${result.savedCount}${result.error ? ` err=${result.error}` : ""}`);
      } catch (err) {
        log(`compaction hook error: ${String(err)}`);
      }
    });

    // ─── Error-memory prefetch: bash failures → related lessons ───
    await ctx.tool.hook("execute.after", async (event) => {
      try {
        if (event.tool !== "bash" && event.tool !== "shell") return;
        const outText = extractToolResultText(event as unknown as { status?: string; result?: unknown });
        if (!outText) return;
        if (!looksLikeBashError(outText)) return;

        const now = Date.now();
        const lastPrefetch = lastPrefetchAt.get(event.sessionID) ?? 0;
        if (now - lastPrefetch < PREFETCH_MIN_INTERVAL_MS) return;
        lastPrefetchAt.set(event.sessionID, now);

        const input = event.input as ToolInput | undefined;
        const cmd = String(input?.["command"] ?? input?.["cmd"] ?? "").slice(0, 200);
        const errSnippet = extractErrorSnippet(outText);
        const query = `${cmd} ${errSnippet}`.slice(0, 300);
        const hits = searchMemories(store, { query, target: "failure", limit: 3 });
        if (hits.length === 0) return;

        const block = [
          "<memory-prefetch>",
          "The last bash command failed. Related lessons from past failures:",
          ...hits.map((h) => `• [${h.target}] ${h.content.slice(0, 400)}`),
          "Use these to avoid repeating past mistakes.",
          "</memory-prefetch>",
        ].join("\n");
        await ctx.session
          .synthetic({ sessionID: event.sessionID, text: block })
          .catch((err: unknown) => log(`memory prefetch inject failed: ${String(err)}`));
        log(`memory prefetch: bash error → ${hits.length} failure hit(s) injected (cmd=${cmd.slice(0, 60)})`);
      } catch (err) {
        log(`tool.execute.after error: ${String(err)}`);
      }
    });

    // ─── Background learning on idle + cleanup on delete ───
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            if (event.type === "session.deleted") {
              const sessionID = (event as unknown as { data?: { sessionID?: string } }).data?.sessionID;
              if (sessionID) {
                sessionTurns.delete(sessionID);
                injectedThisSession.delete(sessionID);
                lastPrefetchAt.delete(sessionID);
                clearSession(sessionID);
                if (lastIdleSession === sessionID) lastIdleSession = null;
              }
              continue;
            }
            if (event.type !== "session.idle") continue;
            const sessionID = (event as unknown as { data?: { sessionID?: string } }).data?.sessionID;
            if (!sessionID || sessionID === lastIdleSession) continue;

            const turns = sessionTurns.get(sessionID) ?? 0;
            if (turns < NUDGE_INTERVAL) continue;
            if (Date.now() - lastReviewAt < REVIEW_MIN_INTERVAL_MS) continue;

            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(async () => {
              try {
                const result = await runBackgroundReviewV2(ctx.session, ctx.generate, store, currentProject, sessionID);
                lastReviewAt = Date.now();
                log(`background review: saved=${result.savedCount}${result.error ? ` err=${result.error}` : ""}`);
                sessionTurns.set(sessionID, 0);
              } catch (err) {
                log(`background review threw: ${String(err)}`);
              } finally {
                idleTimer = null;
                if (lastIdleSession === sessionID) lastIdleSession = null;
              }
            }, IDLE_DEBOUNCE_MS);
            lastIdleSession = sessionID;
          } catch (err) {
            log(`event handler error: ${String(err)}`);
          }
        }
      } catch (err) {
        // AbortError on unload is expected.
        if ((err as Error)?.name !== "AbortError") log(`event subscription error: ${String(err)}`);
      }
    })();

    // ─── Cleanup on unload ───
    return () => {
      controller.abort();
      if (idleTimer) clearTimeout(idleTimer);
      sessionTurns.clear();
      injectedThisSession.clear();
      lastPrefetchAt.clear();
      clearSessionState();
      log("disposed");
    };
  },
});
