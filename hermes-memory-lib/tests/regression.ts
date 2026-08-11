/**
 * Hermes 记忆系统隔离回归测试（标准模板）
 *
 * 用法：bun run test（即 bun run hermes-memory-lib/tests/regression.ts）
 *
 * 隔离原理：setMemoryRoot(临时目录) 让 MemoryStore 的所有路径指向临时目录，
 * 测试全程不触碰真实记忆文件（~/.config/opencode/memory/）。
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { detectCorrection } from "../learn.ts";
import { setMemoryRoot } from "../paths.ts";
import { searchMemories } from "../search.ts";
import { MemoryStore } from "../store.ts";

// ─── 隔离：临时目录 ───
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "hm-iso-"));
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

// ─── 测试开始 ───
const store = new MemoryStore({});
await store.loadFromDisk();
assert("空记忆加载", store.usage().includes("0 entries"), store.usage());

// 1. add / 查重（幂等：重复返回 success + message "already exists"，entry_count 不变）
let r = await store.add("memory", "测试条目A");
assert("add 成功", r.success);
const countAfterAdd = store.usage().match(/\((\d+) entries\)/)?.[1];
r = await store.add("memory", "测试条目A");
const countAfterDup = store.usage().match(/\((\d+) entries\)/)?.[1];
assert(
  "查重不新增",
  r.success && (r.message ?? r.error ?? "").includes("already") && countAfterDup === countAfterAdd,
  `${r.message ?? r.error ?? ""} count ${countAfterAdd}->${countAfterDup}`,
);

// 2. 单条长度上限（MAX_SINGLE_ENTRY_CHARS=3000）
r = await store.add("memory", "X".repeat(4000));
assert("超长拒绝", !r.success, r.error ?? "");

// 3. replace 精确匹配 + 双时态进 history
r = await store.replace("memory", "测试条目A", "测试条目A-更新");
assert("replace 精确", r.success, r.error ?? "");
const hist = await fs.readFile(path.join(TMP, "history.md"), "utf-8");
assert("旧版进 history", hist.includes("测试条目A"), hist);

// 4. remove 精确
r = await store.remove("memory", "测试条目A-更新");
assert("remove 精确", r.success, r.error ?? "");

// 5. failure + category
r = await store.addFailure("失败教训X", { category: "tool-quirk" });
assert("addFailure", r.success, r.error ?? "");

// 6. 全目标检索
await store.add("user", "用户偏好测试");
await store.add("memory", "环境事实测试");
const hits = searchMemories(store, { query: "测试", limit: 10, touch: false });
assert(
  "全目标检索覆盖 user+memory",
  new Set(hits.map((h) => h.target)).has("user") && new Set(hits.map((h) => h.target)).has("memory"),
  hits.map((h) => h.target).join(","),
);

// 7. category 过滤
const failureHits = searchMemories(store, {
  query: "失败",
  target: "failure",
  category: "tool-quirk",
  limit: 5,
  touch: false,
});
assert("failure+category 过滤", failureHits.length === 1, `got ${failureHits.length}`);

// 8. 纠正检测
const fp = ["No, the file is there", "No, it's fine", "Actually, the build passed"].filter(
  (c) => detectCorrection(c).matched,
);
const tp = ["No, use the other config", "No, don't do that"].filter((c) => detectCorrection(c).matched);
assert("纠正检测误报0", fp.length === 0, String(fp.length));
assert("纠正检测真报2", tp.length === 2, String(tp.length));

// 9. matchEntries 精确优先（consolidate 场景：精确匹配不再误报 Multiple）
await store.add("memory", "opencode-go 中转站 A");
await store.add("memory", "opencode-go 中转站 B");
const r2 = await store.remove("memory", "opencode-go 中转站 A");
assert("remove 精确匹配成功", r2.success, r2.error ?? "");
const r3 = await store.replace("memory", "opencode-go 中转站 B", "中转站 B-更新");
assert("replace 精确匹配成功", r3.success, r3.error ?? "");
// 剩余条目无 "opencode-go"（A 已删、B 已改名为 "中转站 B-更新"）
const remains = searchMemories(store, {
  query: "opencode-go",
  limit: 10,
  touch: false,
});
assert("精确匹配后无残留命中", remains.length === 0, String(remains.length));

// 10. project CRUD
r = await store.addToProject("proj-test", "项目记忆条目");
assert("addToProject", r.success, r.error ?? "");
r = await store.replaceProjectEntry("proj-test", "项目记忆条目", "项目记忆条目-更新");
assert("replaceProjectEntry", r.success, r.error ?? "");
r = await store.removeProjectEntry("proj-test", "项目记忆条目-更新");
assert("removeProjectEntry", r.success, r.error ?? "");

// 11. touchEntry 保留 supersedes 演化链元数据（检索命中刷新 last= 不得丢元数据）。
// 当天创建的条目 touch 会跳过刷新路径，因此构造一条 last 为旧日期的条目。
const legacySupersedes = Buffer.from("2026-01-01:旧摘要", "utf-8").toString("base64url");
await fs.writeFile(
  path.join(TMP, "MEMORY.md"),
  `演化链条目-新 <!-- created=2026-01-01, last=2026-01-01, supersedes=${legacySupersedes} -->`,
  "utf-8",
);
await store.loadFromDisk();
const touchHits = searchMemories(store, { query: "演化链条目", limit: 5 }); // touch 默认 true
assert("检索命中触发 touch", touchHits.length > 0);
const rawAfterTouch = store.getRawEntriesFor("memory").find((e) => e.includes("演化链条目-新")) ?? "";
const today = new Date().toISOString().split("T")[0];
assert("touch 后 last= 刷新到今天", rawAfterTouch.includes(`last=${today}`), rawAfterTouch);
assert("touch 后 supersedes 元数据保留", rawAfterTouch.includes(`supersedes=${legacySupersedes}`), rawAfterTouch);

// ─── 清理临时目录 ───
await fs.rm(TMP, { recursive: true, force: true });

// ─── 结论 ───
console.log(`\n${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
