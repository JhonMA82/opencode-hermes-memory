/**
 * Hermes Memory for OpenCode — learning loop, correction detection, consolidation.
 *
 * Ported behavior from pi-hermes-memory handlers:
 *  - background-review.ts  → turn_end every N turns → LLM review → operations
 *  - correction-detector.ts → user message pattern match → immediate failure save
 *  - auto-consolidate.ts   → capacity overflow → LLM consolidation → shrink
 *  - session-flush.ts      → compaction → save what matters
 */

import * as fs from "node:fs/promises";
import type { PluginInput } from "@opencode-ai/plugin";
import { completeWithInternalSession, isInternalSession } from "./llm.ts";
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
  // 允许缺 target（applyOperations 有 "memory" 默认值）；必须至少有 action
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
  // 优先整体解析（content 含 { } 时 first/last 大括号定位会截断 JSON）
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
    // 容错：模型偶尔输出带尾逗号/注释的 JSON，尝试修复后重解析
    try {
      const repaired = cleaned
        .slice(start, end + 1)
        .replace(/,\s*([}\]])/g, "$1") // 去掉尾逗号
        .replace(/\/\/[^\n]*/g, "") // 去掉行注释
        .replace(/\/\*[\s\S]*?\*\//g, ""); // 去掉块注释
      const parsed = JSON.parse(repaired);
      const ops = opsFromParsed(parsed);
      if (ops.length > 0) return { operations: ops };
    } catch {
      /* 修复失败，返回原始错误 */
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
      // 模型经常产出缺 project 名的 project 操作——降级为 memory 目标，避免静默丢失
      const r = await store.add("memory", op.content ?? "");
      if (!r.success) errors.push(`project op without project name (fell back to memory): ${r.error}`);
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

// ─── Background review (session.idle): summarize conversation → save memories ───
/** 每个会话已 review 到的消息数（只总结新消息，避免重复总结已保存内容） */
const reviewedUpTo = new Map<string, number>();

export async function runBackgroundReview(
  client: PluginInput["client"],
  store: MemoryStore,
  directory: string,
  projectId: string,
  sessionID: string,
): Promise<{ savedCount: number; error?: string }> {
  try {
    const msgs = await client.session.messages({ path: { id: sessionID } });
    const all = msgs.data ?? [];
    // 只取上次 review 之后的新消息（首次 review 取全部）。
    // 会话被压缩后消息数会减少（旧消息变 summary），此时 lastCount 可能越界——
    // 重置为 0 从头审查（压缩本身会触发 flush review 兜底，这里尽量覆盖）。
    let lastCount = reviewedUpTo.get(sessionID) ?? 0;
    if (lastCount > all.length) lastCount = 0;
    const fresh = all.slice(lastCount);
    const transcript = buildTranscript(fresh);
    if (!transcript.trim()) return { savedCount: 0 };

    const userPrompt = `${REVIEW_USER_PROMPT}\n\n<conversation>\n${transcript}\n</conversation>\n\nActive project: ${projectId || "(none)"}\nRespond with the operations JSON only.`;
    const completion = await completeWithInternalSession(client, directory, DIRECT_REVIEW_SYSTEM_PROMPT, userPrompt);
    if (completion.error || !completion.text) {
      return { savedCount: 0, error: completion.error || "empty model output" };
    }
    const { operations, error } = extractOperations(completion.text);
    // 解析失败不推进进度（下次重试这些消息）；解析成功（含空 operations）才算处理过
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

// ─── Flush before compaction: save what matters ───
export async function runFlushReview(
  client: PluginInput["client"],
  store: MemoryStore,
  directory: string,
  projectId: string,
  sessionID: string,
): Promise<{ savedCount: number; error?: string }> {
  try {
    const msgs = await client.session.messages({ path: { id: sessionID } });
    const all = msgs.data ?? [];
    // Only look at recent messages (last ~20) to keep it fast and focused.
    const recent = all.slice(-20);
    const transcript = buildTranscript(recent);
    if (!transcript.trim()) return { savedCount: 0 };

    const userPrompt = `Session ${sessionID} (project: ${projectId || "(none)"}) is being compressed.\n\n<conversation>\n${transcript}\n</conversation>\n\nRespond with the operations JSON only.`;
    const completion = await completeWithInternalSession(client, directory, DIRECT_FLUSH_SYSTEM_PROMPT, userPrompt);
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

// ─── Consolidate a full target via LLM (must shrink) ───
const CONSOLIDATE_TIMEOUT_MS = 120_000; // 内部会话可能挂起，120s 超时兜底
const CONSOLIDATE_COOLDOWN_MS = 24 * 60 * 60 * 1000; // Auto-dream 门槛：距上次合并 <24h 不触发
const CONSOLIDATE_MAX_REMOVE_RATIO = 0.5; // 过度删除保护：单次最多移除一半条目

type ConsolidateState = Record<string, string>; // targetKey → last consolidate ISO

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

export async function consolidateTarget(
  client: PluginInput["client"],
  store: MemoryStore,
  target: Target | "project",
  directory: string,
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

  // 提前"占坑"写入冷却时间：consolidate 内部会调 applyMutationPlan，
  // 若其超限再触发 consolidate 会命中此处冷却，防止嵌套递归。
  // 失败也占冷却——一次尝试失败后 24h 内不再重试，避免反复烧 LLM。
  state[key] = new Date().toISOString();
  await writeConsolidateState(state);

  const rawEntries = projectId ? store.getRawProjectEntries(projectId) : store.getRawEntriesFor(target as Target);
  if (rawEntries.length < 2) {
    return { consolidated: false, error: "Too few entries to consolidate." };
  }
  const currentText = rawEntries.join("\n§\n");
  const userPrompt = `Target: ${key}\n\nCurrent entries (with metadata):\n${currentText}\n\nRespond with the operations JSON only. Use target "${target}" for every operation.`;
  const completion = await withTimeout(
    completeWithInternalSession(client, directory, DIRECT_CONSOLIDATION_SYSTEM_PROMPT, userPrompt),
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
  // Force every op to this target, drop non-applicable targets.
  const scoped = operations
    .filter((op) => op.target === target || op.target === undefined)
    .map((op) => ({ ...op, target }));
  if (scoped.length === 0)
    return {
      consolidated: false,
      error: "No operations scoped to this target.",
    };

  // 过度删除保护：remove 操作数不得超过条目总数的一半（保守化兜底，floor 取整更严格）
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

  // project 分支没有 applyMutationPlan 的 requireShrink，这里手动验证：
  // 合并后必须变小，否则 addToProject 重试仍会超限，白跑一次 LLM。
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

/** project 目标没有 applyMutationPlan，走逐条操作（与 applyOperations 一致） */
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

/** Promise 超时包装：超时后返回错误，不挂起调用方 */
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

/** 清理会话级状态（插件 dispose 时调用，防 Map 无限增长） */
export function clearSessionState(): void {
  reviewedUpTo.clear();
}

// ─── Transcript builder ───
// info.summary 用 unknown：OpenCode SDK 的 Message.summary 是对象（{title, body, diffs}），
// 而旧版是 boolean；truthy 判断对两者都成立，行为一致。
type MessageLike = {
  info: { role?: string; summary?: unknown; modelID?: string };
  parts: Array<{ type: string; text?: string; synthetic?: boolean }>;
};

const TRANSCRIPT_MAX_CHARS = 30_000;

function buildTranscript(messages: MessageLike[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.info.summary) continue;
    const text = (msg.parts ?? [])
      .filter((p) => p.type === "text" && typeof p.text === "string" && p.text.trim() && !p.synthetic)
      .map((p) => p.text!.trim())
      .join("\n");
    if (!text) continue;
    const role = msg.info.role === "assistant" ? "assistant" : "user";
    if (msg.info.role === "assistant" && msg.info.modelID) {
      lines.push(`<assistant model="${msg.info.modelID}">\n${text}\n</assistant>`);
    } else {
      lines.push(`<${role}>\n${text}\n</${role}>`);
    }
  }
  // Keep the most recent content when over budget (drop oldest messages).
  let joined = lines.join("\n\n");
  while (joined.length > TRANSCRIPT_MAX_CHARS && lines.length > 1) {
    lines.shift();
    joined = lines.join("\n\n");
  }
  return joined;
}

export { isInternalSession };
