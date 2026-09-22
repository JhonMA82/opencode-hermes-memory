/**
 * Hermes Memory — learning loop, correction detection, consolidation.
 *
 * V2 native path uses dependency injection:
 *   LearnDeps { getMessages(sessionID), complete(system, user) }
 * backed by `ctx.session.context` + `ctx.generate.text`.
 */

import * as fs from "node:fs/promises";
import { completeWithGenerate, type InternalCompletion } from "./llm.ts";
import { consolidateStateFile } from "./paths.ts";
import {
  CORRECTION_DIRECTIVE_WORDS,
  CORRECTION_NEGATIVE_PATTERNS,
  CORRECTION_STRONG_PATTERNS,
  CORRECTION_WEAK_PATTERNS,
  DIRECT_CONSOLIDATION_SYSTEM_PROMPT,
  DIRECT_FLUSH_SYSTEM_PROMPT,
  DIRECT_REVIEW_SYSTEM_PROMPT,
  REVIEW_USER_PROMPT,
} from "./prompts.ts";
import type { MemoryMutationOperation, MemoryStore, Target } from "./store.ts";

// ─── Correction detection (rule-based, zero LLM cost) ───
export type CorrectionMatch = {
  matched: boolean;
  reason?: string;
};

export function detectCorrection(text: string): CorrectionMatch {
  const firstLine = text.split("\n")[0].trim();
  if (firstLine.length > 200) return { matched: false };
  if (CORRECTION_NEGATIVE_PATTERNS.some((re) => re.test(firstLine))) return { matched: false };
  if (CORRECTION_STRONG_PATTERNS.some((re) => re.test(firstLine))) {
    return { matched: true, reason: "strong-pattern" };
  }
  const weak = CORRECTION_WEAK_PATTERNS.find((re) => re.test(firstLine));
  if (weak) {
    const rest = firstLine.replace(weak, "").trim();
    const hasDirective = CORRECTION_DIRECTIVE_WORDS.some((word) =>
      new RegExp(`\\b${word.replace("'", "['']?")}\\b`, "i").test(rest),
    );
    if (hasDirective) return { matched: true, reason: "weak-pattern+directive" };
  }
  return { matched: false };
}

// ─── Operations extraction from LLM JSON output ───
type RawOperation = { action?: unknown; [key: string]: unknown };

function opsFromParsed(parsed: unknown): MemoryMutationOperation[] {
  const rawOps = Array.isArray(parsed) ? parsed : (parsed as RawOperation | null)?.operations;
  const ops = Array.isArray(rawOps) ? rawOps : [];
  return ops.filter((op): op is MemoryMutationOperation => {
    if (!op || typeof op !== "object") return false;
    const candidate = op as RawOperation;
    return typeof candidate.action === "string" && candidate.action.length > 0;
  });
}

export function extractOperations(text: string): {
  operations: MemoryMutationOperation[];
  error?: string;
} {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    const ops = opsFromParsed(parsed);
    return { operations: ops };
  } catch {
    /* fall through to brace-slice */
  }

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return { operations: [], error: "No JSON object found in model output." };
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    const ops = opsFromParsed(parsed);
    return { operations: ops };
  } catch (err) {
    try {
      const repaired = cleaned
        .slice(start, end + 1)
        .replace(/,\s*([}\]])/g, "$1")
        .replace(/\/\/[^\n]*/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      const parsed = JSON.parse(repaired);
      const ops = opsFromParsed(parsed);
      if (ops.length > 0) return { operations: ops };
    } catch {
      /* repair failed */
    }
    return {
      operations: [],
      error: `Failed to parse operations JSON: ${String(err)}`,
    };
  }
}

// ─── Apply operations across targets ───
export async function applyOperations(
  store: MemoryStore,
  operations: MemoryMutationOperation[],
): Promise<{ errors: string[] }> {
  const errors: string[] = [];
  const byTarget = new Map<Target, MemoryMutationOperation[]>();
  const projectOps: MemoryMutationOperation[] = [];

  for (const op of operations) {
    if (op.target === "project") {
      projectOps.push(op);
      continue;
    }
    const t = (op.target ?? "memory") as Target;
    if (!byTarget.has(t)) byTarget.set(t, []);
    byTarget.get(t)!.push(op);
  }

  for (const [target, ops] of byTarget) {
    const result = await store.applyMutationPlan(target, ops);
    if (!result.success) errors.push(`${target}: ${result.error}`);
  }

  for (const op of projectOps) {
    if (!op.project) {
      errors.push("project op without project name: skipped (no fallback — specify project explicitly).");
      continue;
    }
    if (op.action === "add") {
      const r = await store.addToProject(op.project, op.content ?? "");
      if (!r.success) errors.push(`project ${op.project}: ${r.error}`);
    } else if (op.action === "replace") {
      const r = await store.replaceProjectEntry(op.project, op.old_text ?? "", op.content ?? "");
      if (!r.success) errors.push(`project ${op.project}: ${r.error}`);
    } else if (op.action === "remove") {
      const r = await store.removeProjectEntry(op.project, op.old_text ?? "");
      if (!r.success) errors.push(`project ${op.project}: ${r.error}`);
    }
  }

  return { errors };
}

// ─── LearnDeps: injected transcript + completion ───
export type LearnDeps = {
  getMessages: (sessionID: string) => Promise<unknown[]>;
  complete: (system: string, user: string) => Promise<InternalCompletion>;
};

/** Each session's already-reviewed message count (only summarize new messages). */
const reviewedUpTo = new Map<string, number>();

async function runBackgroundReviewCore(
  deps: LearnDeps,
  store: MemoryStore,
  projectId: string,
  sessionID: string,
): Promise<{ savedCount: number; error?: string }> {
  try {
    const all = (await deps.getMessages(sessionID)) ?? [];
    let lastCount = reviewedUpTo.get(sessionID) ?? 0;
    if (lastCount > all.length) lastCount = 0;
    const fresh = all.slice(lastCount);
    const transcript = buildTranscript(fresh);
    if (!transcript.trim()) return { savedCount: 0 };

    const userPrompt = `${REVIEW_USER_PROMPT}\n\n<conversation>\n${transcript}\n</conversation>\n\n${existingMemorySection(store, projectId)}Active project: ${projectId || "(none)"}\nRespond with the operations JSON only.`;
    const completion = await deps.complete(DIRECT_REVIEW_SYSTEM_PROMPT, userPrompt);
    if (completion.error || !completion.text) {
      return { savedCount: 0, error: completion.error || "empty model output" };
    }
    const { operations, error } = extractOperations(completion.text);
    if (error) return { savedCount: 0, error };
    reviewedUpTo.set(sessionID, all.length);
    if (operations.length === 0) return { savedCount: 0 };
    const applied = await applyOperations(store, operations);
    return {
      savedCount: operations.length - applied.errors.length,
      error: applied.errors.join("; ") || undefined,
    };
  } catch (err) {
    return { savedCount: 0, error: String(err) };
  }
}

async function runFlushReviewCore(
  deps: LearnDeps,
  store: MemoryStore,
  projectId: string,
  sessionID: string,
): Promise<{ savedCount: number; error?: string }> {
  try {
    const all = (await deps.getMessages(sessionID)) ?? [];
    const recent = all.slice(-20);
    const transcript = buildTranscript(recent);
    if (!transcript.trim()) return { savedCount: 0 };

    const userPrompt = `Session ${sessionID} (project: ${projectId || "(none)"}) is being compressed.\n\n<conversation>\n${transcript}\n</conversation>\n\nRespond with the operations JSON only.`;
    const completion = await deps.complete(DIRECT_FLUSH_SYSTEM_PROMPT, userPrompt);
    if (completion.error || !completion.text) return { savedCount: 0, error: completion.error || "empty model output" };
    const { operations, error } = extractOperations(completion.text);
    if (error) return { savedCount: 0, error };
    if (operations.length === 0) return { savedCount: 0 };
    const applied = await applyOperations(store, operations);
    return {
      savedCount: operations.length - applied.errors.length,
      error: applied.errors.join("; ") || undefined,
    };
  } catch (err) {
    return { savedCount: 0, error: String(err) };
  }
}

// ─── V2 entry points (ctx.session.context + ctx.generate.text) ───
type V2SessionLike = {
  context: (input: { sessionID: string }) => Promise<unknown[] | { data?: unknown[] }>;
};
type V2GenerateLike = {
  text: (input: { prompt: string; model?: { providerID: string; id: string } }) => Promise<{ text: string }>;
};

function v2Deps(session: V2SessionLike, generate: V2GenerateLike): LearnDeps {
  return {
    getMessages: async (sessionID: string) => {
      const res = await session.context({ sessionID });
      if (Array.isArray(res)) return res;
      if (res && typeof res === "object" && Array.isArray((res as { data?: unknown[] }).data)) {
        return (res as { data: unknown[] }).data;
      }
      return [];
    },
    complete: (system, user) =>
      completeWithGenerate((input) => generate.text(input as never) as Promise<{ text: string }>, system, user),
  };
}

export async function runBackgroundReviewV2(
  session: V2SessionLike,
  generate: V2GenerateLike,
  store: MemoryStore,
  projectId: string,
  sessionID: string,
): Promise<{ savedCount: number; error?: string }> {
  return runBackgroundReviewCore(v2Deps(session, generate), store, projectId, sessionID);
}

export async function runFlushReviewV2(
  session: V2SessionLike,
  generate: V2GenerateLike,
  store: MemoryStore,
  projectId: string,
  sessionID: string,
): Promise<{ savedCount: number; error?: string }> {
  return runFlushReviewCore(v2Deps(session, generate), store, projectId, sessionID);
}

// ─── Consolidate a full target via LLM (must shrink) ───
const CONSOLIDATE_TIMEOUT_MS = 120_000;
const CONSOLIDATE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const CONSOLIDATE_MAX_REMOVE_RATIO = 0.5;

type ConsolidateState = Record<string, string>;

async function readConsolidateState(): Promise<ConsolidateState> {
  try {
    const raw = await fs.readFile(consolidateStateFile(), "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeConsolidateState(state: ConsolidateState): Promise<void> {
  try {
    await fs.writeFile(consolidateStateFile(), JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    logDebug(`consolidate state write failed: ${String(err)}`);
  }
}

function targetKey(target: Target | "project", projectId?: string): string {
  return projectId ? `project:${projectId}` : target;
}

async function consolidateTargetCore(
  complete: (system: string, user: string) => Promise<InternalCompletion>,
  store: MemoryStore,
  target: Target | "project",
  projectId?: string,
): Promise<{ consolidated: boolean; deferred?: boolean; error?: string }> {
  const key = targetKey(target, projectId);
  const state = await readConsolidateState();
  const last = state[key];
  if (last) {
    const lastTime = Date.parse(last);
    if (!Number.isNaN(lastTime) && Date.now() - lastTime < CONSOLIDATE_COOLDOWN_MS) {
      const hoursLeft = Math.ceil((CONSOLIDATE_COOLDOWN_MS - (Date.now() - lastTime)) / 3_600_000);
      return {
        consolidated: false,
        deferred: true,
        error: `Consolidation for '${key}' ran less than 24h ago (${hoursLeft}h left). Skipping to avoid churn.`,
      };
    }
  }

  const rawEntries = projectId ? store.getRawProjectEntries(projectId) : store.getRawEntriesFor(target as Target);
  if (rawEntries.length < 2) {
    return { consolidated: false, error: "Too few entries to consolidate." };
  }

  state[key] = new Date().toISOString();
  await writeConsolidateState(state);
  const currentText = rawEntries.join("\n§\n");
  const userPrompt = `Target: ${key}\n\nCurrent entries (with metadata):\n${currentText}\n\nRespond with the operations JSON only. Use target "${target}" for every operation.`;
  const completion = await withTimeout(
    complete(DIRECT_CONSOLIDATION_SYSTEM_PROMPT, userPrompt),
    CONSOLIDATE_TIMEOUT_MS,
    "consolidation timed out",
  );
  logDebug(`consolidate ${key}: completion=${completion.text.length > 0} err=${completion.error ?? "none"}`);
  if (completion.error || !completion.text) {
    return {
      consolidated: false,
      error: completion.error || "empty model output",
    };
  }
  const { operations, error } = extractOperations(completion.text);
  logDebug(`consolidate ${key}: ops=${operations.length} parseErr=${error ?? "none"}`);
  if (error) return { consolidated: false, error };
  if (operations.length === 0) return { consolidated: false, error: "Model produced no operations." };
  const scoped = operations
    .filter((op) => op.target === target || op.target === undefined)
    .map((op) => ({ ...op, target }));
  if (scoped.length === 0)
    return {
      consolidated: false,
      error: "No operations scoped to this target.",
    };

  const removeCount = scoped.filter((op) => op.action === "remove").length;
  if (removeCount > Math.floor(rawEntries.length * CONSOLIDATE_MAX_REMOVE_RATIO)) {
    return {
      consolidated: false,
      error: `Consolidation plan would remove ${removeCount}/${rawEntries.length} entries — over the ${Math.round(CONSOLIDATE_MAX_REMOVE_RATIO * 100)}% safety cap. Rejected to avoid data loss.`,
    };
  }

  const result = projectId
    ? await applyProjectConsolidation(store, projectId, scoped)
    : await store.applyMutationPlan(target as Target, scoped, {
        requireShrink: true,
      });
  if (!result.success) return { consolidated: false, error: result.error };

  if (projectId) {
    const after = store.getRawProjectEntries(projectId).join("\n§\n").length;
    if (after >= currentText.length) {
      return {
        consolidated: false,
        error: `Consolidation did not shrink project memory (${currentText.length} -> ${after} chars).`,
      };
    }
  }

  return { consolidated: true };
}

/**
 * V2 consolidate with explicit store + generate (used by the plugin entry's
 * setConsolidator closure).
 */
export async function consolidateTargetV2(
  generate: V2GenerateLike,
  store: MemoryStore,
  target: Target | "project",
  projectId?: string,
): Promise<{ consolidated: boolean; deferred?: boolean; error?: string }> {
  const complete = (system: string, user: string) =>
    completeWithGenerate((input) => generate.text(input as never) as Promise<{ text: string }>, system, user);
  const completionRunner = (system: string, user: string) =>
    withTimeout(complete(system, user), CONSOLIDATE_TIMEOUT_MS, "consolidation timed out").catch(
      (err): InternalCompletion => ({ text: "", error: String(err instanceof Error ? err.message : String(err)) }),
    );
  return consolidateTargetCore(completionRunner, store, target, projectId);
}

/** project target consolidation (no applyMutationPlan path). */
async function applyProjectConsolidation(
  store: MemoryStore,
  projectId: string,
  operations: MemoryMutationOperation[],
): Promise<{ success: boolean; error?: string }> {
  for (const op of operations) {
    if (op.action === "add") {
      const r = await store.addToProject(projectId, op.content ?? "");
      if (!r.success)
        return {
          success: false,
          error: `project ${projectId} add: ${r.error}`,
        };
    } else if (op.action === "replace") {
      const r = await store.replaceProjectEntry(projectId, op.old_text ?? "", op.content ?? "");
      if (!r.success)
        return {
          success: false,
          error: `project ${projectId} replace: ${r.error}`,
        };
    } else if (op.action === "remove") {
      const r = await store.removeProjectEntry(projectId, op.old_text ?? "");
      if (!r.success)
        return {
          success: false,
          error: `project ${projectId} remove: ${r.error}`,
        };
    }
  }
  return { success: true };
}

/** Promise timeout: return error instead of hanging the caller. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// ─── Debug log hook (injected by plugin entry) ───
export let logDebug: (msg: string) => void = () => {};
export function setDebugLogger(fn: (msg: string) => void): void {
  logDebug = fn;
}

/** Clear one session's state (on session.deleted). */
export function clearSession(sessionID: string): void {
  reviewedUpTo.delete(sessionID);
}

/** Clear session-level state (on plugin unload). */
export function clearSessionState(): void {
  reviewedUpTo.clear();
}

// ─── Transcript builder (V2 SessionMessageInfo; V1 shape kept for legacy transcripts) ───
/** Existing-memory list cap for the review model (avoid duplicate saves). */
const EXISTING_MEMORY_MAX_CHARS = 4000;

function existingMemorySection(store: MemoryStore, projectId: string): string {
  const lines = [...store.getMemoryEntries(), ...store.getUserEntries(), ...store.getProjectEntries(projectId)].filter(
    Boolean,
  );
  if (lines.length === 0) return "";
  let listing = "";
  for (const line of lines) {
    if (listing.length + line.length + 3 > EXISTING_MEMORY_MAX_CHARS) break;
    listing += `- ${line}\n`;
  }
  return `<existing-memory>\n${listing}</existing-memory>\n\n`;
}

type V1MessageLike = {
  info: { role?: string; summary?: unknown; modelID?: string };
  parts: Array<{ type: string; text?: string; synthetic?: boolean }>;
};

type V2ContentPart = { type?: string; text?: string };
type V2MessageLike = {
  type?: string;
  text?: string;
  content?: V2ContentPart[] | string;
  role?: string;
  info?: { role?: string; summary?: unknown; modelID?: string };
  parts?: Array<{ type: string; text?: string; synthetic?: boolean }>;
};

const TRANSCRIPT_MAX_CHARS = 30_000;

function messageToLines(msg: unknown): { role: string; text: string; modelID?: string } | null {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as V2MessageLike;
  // V1 shape: { info: { role, summary, modelID }, parts: [...] }
  if (m.info && Array.isArray(m.parts)) {
    const v1 = msg as V1MessageLike;
    if (v1.info.summary) return null;
    const text = (v1.parts ?? [])
      .filter((p) => p.type === "text" && typeof p.text === "string" && p.text.trim() && !p.synthetic)
      .map((p) => p.text!.trim())
      .join("\n");
    if (!text) return null;
    const role = v1.info.role === "assistant" ? "assistant" : "user";
    return { role, text, modelID: v1.info.role === "assistant" ? v1.info.modelID : undefined };
  }
  // V2 shape: SessionMessageInfo union
  const t = m.type;
  if (t === "user" && typeof m.text === "string" && m.text.trim()) {
    return { role: "user", text: m.text.trim() };
  }
  if (t === "assistant") {
    const content = m.content;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      text = content
        .filter((p) => p && p.type === "text" && typeof p.text === "string" && p.text.trim())
        .map((p) => p.text!.trim())
        .join("\n");
    }
    if (!text.trim()) return null;
    return { role: "assistant", text: text.trim() };
  }
  // synthetic/system/skill/shell/compaction/idle → skip (not conversation)
  return null;
}

function buildTranscript(messages: unknown[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const parsed = messageToLines(msg);
    if (!parsed) continue;
    if (parsed.role === "assistant" && parsed.modelID) {
      lines.push(`<assistant model="${parsed.modelID}">\n${parsed.text}\n</assistant>`);
    } else {
      lines.push(`<${parsed.role}>\n${parsed.text}\n</${parsed.role}>`);
    }
  }
  let joined = lines.join("\n\n");
  while (joined.length > TRANSCRIPT_MAX_CHARS && lines.length > 1) {
    lines.shift();
    joined = lines.join("\n\n");
  }
  return joined;
}

export type { V1MessageLike as MessageLike };
export { buildTranscript };
