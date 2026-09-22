/**
 * Hermes Memory for OpenCode — paths.
 *
 * Data root: ~/.config/opencode/memory/
 *   USER.md               user profile (who the user is)
 *   MEMORY.md             global agent notes (env facts, conventions, tool quirks)
 *   failures.md           categorized lessons (failure/correction/insight/convention/preference/tool-quirk)
 *   STANDING.md           hard standing instructions (injected every session)
 *   projects-memory/<id>/ MEMORY.md  per-project memory
 */
import * as os from "node:os";
import * as path from "node:path";

export let MEMORY_ROOT = path.join(os.homedir(), ".config", "opencode", "memory");
export const PROJECTS_MEMORY_DIR = "projects-memory";

/**
 * 设置数据根目录（测试隔离用）：所有路径函数基于此目录。
 * 测试脚本应先 setMemoryRoot(临时目录) 再创建 MemoryStore，完全隔离真实记忆。
 * 注意：进程级可变状态，仅用于测试；生产代码不要调用。
 */
export function setMemoryRoot(root: string): void {
  MEMORY_ROOT = root;
}

export function memoryRoot(): string {
  return MEMORY_ROOT;
}

export function userFile(): string {
  return path.join(MEMORY_ROOT, "USER.md");
}
export function memoryFile(): string {
  return path.join(MEMORY_ROOT, "MEMORY.md");
}
export function failuresFile(): string {
  return path.join(MEMORY_ROOT, "failures.md");
}
export function standingFile(): string {
  return path.join(MEMORY_ROOT, "STANDING.md");
}
export function projectMemoryDir(projectId: string): string {
  return path.join(MEMORY_ROOT, PROJECTS_MEMORY_DIR, sanitizeProjectId(projectId));
}
export function projectMemoryFile(projectId: string): string {
  return path.join(projectMemoryDir(projectId), "MEMORY.md");
}
/** Auto-dream 状态文件：记录每个 target 上次 consolidate 的时间（ISO 字符串） */
export function consolidateStateFile(): string {
  return path.join(MEMORY_ROOT, ".consolidate-state.json");
}
/** Double-temporal evolution history file: superseded old entries (no capacity, no retrieval) */
export function historyFile(): string {
  return path.join(MEMORY_ROOT, "history.md");
}

/**
 * Sanitize a project id for safe use as a single path segment.
 * Project ids can come from LLM-controlled tool input (`project` param),
 * so raw values must never flow into `path.join` unchecked (`../../evil`
 * would escape MEMORY_ROOT). Allowed: letters, digits, `.`, `-`, `_`,
 * max 64 chars. Anything else is replaced with `_`; empty results fall
 * back to `default`. The sanitized value is always a single safe segment.
 */
export function sanitizeProjectId(projectId: string): string {
  const trimmed = (projectId ?? "").trim();
  if (!trimmed) return "default";
  const sanitized = trimmed.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
  if (!sanitized || sanitized === "." || sanitized === "..") return "default";
  return sanitized;
}

/**
 * Strict validation for project ids supplied via tools.
 * Returns an error message when the id is missing or would be altered by
 * sanitization (possible traversal or separator injection); null when ok.
 */
export function validateProjectId(projectId: unknown): string | null {
  if (typeof projectId !== "string" || !projectId.trim()) return "Project name cannot be empty.";
  const trimmed = projectId.trim();
  if (trimmed.length > 64) return "Project name too long (max 64 characters).";
  if (trimmed === "." || trimmed === "..") return "Invalid project name.";
  if (/[^A-Za-z0-9._-]/.test(trimmed)) {
    return `Invalid project name '${trimmed}'. Use only letters, digits, '.', '-', '_'.`;
  }
  return null;
}
