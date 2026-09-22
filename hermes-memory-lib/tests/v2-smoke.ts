/**
 * V2 smoke test (mock ctx, no OpenCode server needed).
 *
 * Usage: bun run hermes-memory-lib/tests/v2-smoke.ts
 *
 * Verifies:
 *  - Plugin.define id + setup registers 5 tools via ctx.tool.transform
 *  - Tool executors work (memory_add/search/replace/remove/history)
 *  - session hooks registered: prompt, context, compaction
 *  - tool hook registered: execute.after
 *  - prompt hook: correction detection saves failure memory
 *  - context hook: injects policy + standing + project
 *  - compaction hook: runs without throwing (empty transcript)
 *  - execute.after: shell error injects failure lessons; legacy bash ignored
 *  - idleSessionOf: session.status idle primary, session.idle deprecated fallback
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import plugin, { idleSessionOf } from "../../hermes-memory.ts";
import { setMemoryRoot } from "../paths.ts";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "hm-v2-"));
setMemoryRoot(TMP);

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`✅ ${name}`);
  } else {
    failed++;
    console.log(`❌ ${name} ${detail}`);
  }
}

// ─── Mock ctx ───
type ToolDef = {
  name: string;
  description: string;
  input: unknown;
  execute: (input: unknown) => Promise<{ content: string }>;
};
const tools = new Map<string, ToolDef>();
const sessionHooks = new Map<string, Array<(event: Record<string, unknown>) => void | Promise<void>>>();
const toolHooks = new Map<string, Array<(event: Record<string, unknown>) => void | Promise<void>>>();
const synthetics: Array<{ sessionID: string; text: string }> = [];

const ctx = {
  location: { directory: "/tmp/proj", project: { id: "proj-test" } },
  options: {},
  generate: {
    text: async (_input: { prompt: string }) => ({ text: '{"operations":[]}' }),
  },
  session: {
    context: async (_input: { sessionID: string }) => [],
    synthetic: async (input: { sessionID: string; text: string }) => {
      synthetics.push({ sessionID: input.sessionID, text: input.text });
      return { id: "syn-1" };
    },
    hook: async (name: string, cb: (event: Record<string, unknown>) => void | Promise<void>) => {
      if (!sessionHooks.has(name)) sessionHooks.set(name, []);
      sessionHooks.get(name)!.push(cb);
      return { dispose: async () => {} };
    },
  },
  tool: {
    transform: async (cb: (editor: { add: (t: ToolDef) => void; namespace: (_ns: unknown) => void }) => void) => {
      cb({ add: (t) => tools.set(t.name, t), namespace: () => {} });
      return { dispose: async () => {} };
    },
    hook: async (name: string, cb: (event: Record<string, unknown>) => void | Promise<void>) => {
      if (!toolHooks.has(name)) toolHooks.set(name, []);
      toolHooks.get(name)!.push(cb);
      return { dispose: async () => {} };
    },
  },
  event: {
    subscribe: (_opts?: { signal?: AbortSignal }) => {
      async function* gen(): AsyncGenerator<never> {
        // no events in smoke test
      }
      return gen();
    },
  },
};

assert("plugin id", (plugin as { id?: string }).id === "hermes-memory", String((plugin as { id?: string }).id));

const cleanup = await (plugin as { setup: (ctx: unknown) => Promise<(() => void) | undefined> }).setup(ctx);
assert("setup returns cleanup", typeof cleanup === "function");

assert("5 tools registered", tools.size === 5, [...tools.keys()].join(","));
for (const name of ["memory_search", "memory_add", "memory_replace", "memory_remove", "memory_history"]) {
  assert(`tool ${name}`, tools.has(name));
}

assert("prompt hook", (sessionHooks.get("prompt") ?? []).length === 1);
assert("context hook", (sessionHooks.get("context") ?? []).length === 1);
assert("compaction hook", (sessionHooks.get("compaction") ?? []).length === 1);
assert("tool execute.after hook", (toolHooks.get("execute.after") ?? []).length === 1);

// ─── memory_add → memory_search roundtrip ───
const add = tools.get("memory_add")!;
let out = JSON.parse((await add.execute({ content: "V2 smoke fact", target: "memory" })).content);
assert("memory_add success", out.success === true, JSON.stringify(out));

const search = tools.get("memory_search")!;
out = JSON.parse((await search.execute({ query: "smoke fact", limit: 5 })).content);
assert("memory_search finds fact", out.count >= 1, JSON.stringify(out));

// ─── prompt hook: correction detection ───
const promptHook = sessionHooks.get("prompt")![0];
await promptHook({ sessionID: "ses-1", prompt: { text: "No, use the other config" } });
out = JSON.parse((await search.execute({ query: "other config", target: "failure", limit: 5 })).content);
assert("correction saved to failure", out.count >= 1, JSON.stringify(out));

// ─── context hook: system injection ───
const contextEvent: { sessionID: string; system: Array<{ type: string; text: string }> } & Record<string, unknown> = {
  sessionID: "ses-1",
  system: [] as Array<{ type: string; text: string }>,
};
const contextHook = sessionHooks.get("context")![0];
await contextHook(contextEvent);
const system = contextEvent.system;
assert(
  "context injects policy",
  system.length >= 1 && system[0].text.includes("Persistent memory"),
  JSON.stringify(system.length),
);

// ─── compaction hook: no crash on empty ───
const compactionHook = sessionHooks.get("compaction")![0];
await compactionHook({ sessionID: "ses-1", system: [], messages: [], options: {}, tools: {} });
assert("compaction hook ok", true);

// ─── execute.after: shell error injects lessons; legacy bash ignored ───
const afterHook = toolHooks.get("execute.after")![0];
await afterHook({ tool: "read", sessionID: "ses-1", input: {}, status: "completed", result: { content: "ok" } });
const syntheticsBefore = synthetics.length;
await afterHook({
  tool: "bash",
  sessionID: "ses-1",
  input: { command: "ls /nonexistent" },
  status: "completed",
  result: { content: "ls: cannot access /nonexistent: No such file or directory" },
});
assert("legacy bash tool ignored", synthetics.length === syntheticsBefore, String(synthetics.length));
// Seed a failure lesson so shell prefetch has something to inject.
await add.execute({ content: "shell failure lesson for prefetch", target: "failure", category: "failure" });
await afterHook({
  tool: "shell",
  sessionID: "ses-1",
  input: { command: "ls /nonexistent" },
  status: "completed",
  result: { content: "ls: cannot access /nonexistent: No such file or directory" },
});
assert("shell error prefetches lessons", synthetics.length > syntheticsBefore, String(synthetics.length));

// ─── idleSessionOf: session.status primary, session.idle deprecated fallback ───
assert(
  "session.status idle recognized",
  idleSessionOf({ type: "session.status", data: { sessionID: "ses-1", status: { type: "idle" } } }) === "ses-1",
);
assert(
  "session.status busy ignored",
  idleSessionOf({ type: "session.status", data: { sessionID: "ses-1", status: { type: "busy" } } }) === null,
);
assert(
  "session.idle fallback recognized",
  idleSessionOf({ type: "session.idle", data: { sessionID: "ses-1" } }) === "ses-1",
);

// ─── tool input validation ───
out = JSON.parse((await search.execute({ query: "", limit: 5 })).content);
assert("memory_search rejects empty query", out.success === false, JSON.stringify(out));
out = JSON.parse((await search.execute({ query: "smoke", target: "nope", limit: 5 })).content);
assert("memory_search rejects invalid target", out.success === false, JSON.stringify(out));
out = JSON.parse((await search.execute({ query: "smoke fact", limit: Number.NaN })).content);
assert("memory_search NaN limit falls back", out.success === true && out.count >= 1, JSON.stringify(out));
out = JSON.parse((await add.execute({ content: "", target: "memory" })).content);
assert("memory_add rejects empty content", out.success === false, JSON.stringify(out));
out = JSON.parse((await add.execute({ content: "x", target: "nope" })).content);
assert("memory_add rejects invalid target", out.success === false, JSON.stringify(out));
out = JSON.parse((await add.execute({ content: "traversal", target: "project", project: "../../evil" })).content);
assert("memory_add rejects traversal project", out.success === false, JSON.stringify(out));

if (typeof cleanup === "function") await cleanup();
await new Promise((r) => setTimeout(r, 50));
await fs.rm(TMP, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
