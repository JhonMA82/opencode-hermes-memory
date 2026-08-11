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
  return path.join(MEMORY_ROOT, PROJECTS_MEMORY_DIR, projectId);
}
export function projectMemoryFile(projectId: string): string {
  return path.join(projectMemoryDir(projectId), "MEMORY.md");
}
/** Auto-dream 状态文件：记录每个 target 上次 consolidate 的时间（ISO 字符串） */
export function consolidateStateFile(): string {
  return path.join(MEMORY_ROOT, ".consolidate-state.json");
}
/** 双时态演化历史文件：被取代的旧条目（不占容量、不参与检索） */
export function historyFile(): string {
  return path.join(MEMORY_ROOT, "history.md");
}
