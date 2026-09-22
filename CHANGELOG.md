# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Fixed
- Lifecycle (upstream contrast, not just installed types): `session.idle` is `// deprecated` in `packages/schema/src/session-status-event.ts` (v2.0.11 source) — background learning now triggers on `session.status` idle as primary, keeping `session.idle` only as deprecated fallback (`idleSessionOf`, exported for tests)
- Lifecycle: V2 tool name is `shell` (`packages/core/src/tool/plugin/shell.ts`, `export const name = "shell"` — no `bash` tool exists) — `execute.after` no longer matches legacy `bash`, only `shell`; prefetch copy updated shell-first
- Security: sanitize/validate project ids (`sanitizeProjectId`/`validateProjectId`) — LLM-controlled `project` params can no longer traverse outside `projects-memory/` (`../../evil` rejected, no disk write)
- Idle debounce is now per-session (`idleTimers` map) — an idle from session B no longer cancels a pending review for session A; deleted sessions clear their own timer
- Tool input validation: `memory_search`/`memory_add`/`memory_replace`/`memory_remove` reject empty `query`/`content`/`old_text` and unknown `target`/`category`; `limit` NaN falls back instead of returning empty
- `applyOperations` no longer silently falls back project ops without a project name to global `memory` — now recorded as an explicit error
- `package.json`: removed duplicate `@opencode/plugin` (dev vs dependencies) so `bun install --frozen-lockfile` passes; `main` aligned to `index.ts` (matches `exports`)
- CI: runs `bun run test` (regression + V2 smoke), `bun run lint` (includes `index.ts`), pinned Bun `1.4.0`
- Docs: `README.zh-CN.md` updated to V2 parity (hooks, `plugins` array, `@opencode/plugin`, options, dev commands); `README.md`/`CONTRIBUTING.md` synced (test counts, `llm.ts` V2 channel, `index.ts`)
- Prompts: clarified ≤300 chars recommended, hard max 3000 (was contradictory `must be ≤300` vs store `3000`)
- `STANDING_MAX_ENTRIES` (20) now enforced in `formatStandingForPrompt` (was defined but unused)
- `LOG_FILE` uses `os.homedir()` (was `process.env.HOME ?? "."`)

### Changed (BREAKING: requires OpenCode >= 2.0)
- Removed V1 dead code after the 0.4.0 break: `completeWithInternalSession`/`isInternalSession*` (`llm.ts`), V1 wrappers `runBackgroundReview`/`runFlushReview`/`consolidateTarget` (`learn.ts`)

### Added
- Regression: project traversal rejection, `validate`/`sanitize` round-trip, `STANDING` 20-entry cap (35 assertions)
- V2 smoke: invalid target/category, empty query/content, NaN limit fallback, traversal rejection, shell-only prefetch + `session.status`/`session.idle` idle mapping (28 assertions)

## [0.4.0] - 2026-09-20

### Changed (BREAKING: requires OpenCode >= 2.0)
- Native V2 plugin: `Plugin.define({ id: "hermes-memory", setup })` from `@opencode/plugin@2.0.11`
- Tools via `ctx.tool.transform` (JSON Schema, `{ content }` results); hooks via `ctx.session.hook("prompt"|"context"|"compaction")`, `ctx.tool.hook("execute.after")`, `ctx.event.subscribe()`
- LLM via `ctx.generate.text()` — no internal sessions, no idle→LLM→idle loop, no session cleanup
- Injection via `ctx.session.synthetic()` instead of `noReply` prompts
- V2 event shapes: `session.idle` / `session.deleted` carry `data.sessionID`
- Transcript builder handles both V1 (`{info, parts}`) and V2 (`SessionMessageInfo`) message shapes
- `consolidateTargetV2` / `runBackgroundReviewV2` / `runFlushReviewV2` with injected `LearnDeps`
- New `hermesNudgeInterval` plugin option (env `HERMES_NUDGE_INTERVAL` still works as fallback)
- V1 `server()` export removed — OpenCode 1.x users stay on v0.3.x
- Added `hermes-memory-lib/tests/v2-smoke.ts` (mock ctx: tools, hooks, correction, injection, compaction, prefetch)

## [0.3.1] - 2026-08-12

### Fixed
- consolidate 冷却时间不再被"条目太少"的无操作检查消耗（<2 条直接返回，不占 24h 冷却）

### Changed
- 删除死代码链：`formatForSystemPrompt`（无调用方）及其独占的 `snapshot`/`refreshSnapshot`/`renderBlock`/`getFailureEntries`/`getAllFailureEntries`/failure-injection 配置项，以及无调用方的 `loadStanding`/`getStanding`
- 回归测试新增 `extractOperations` 解析容错断言（fenced JSON / 尾逗号修复 / 无 JSON 报错 / 数组形式），21 → 25
- 测试 teardown 等待 fire-and-forget 落盘完成，消除竞态噪音

## [0.3.0] - 2026-08-11

### Fixed
- `touchEntry` 刷新 `last=` 时丢失 `supersedes`/`superseded` 演化链元数据（replace 留下的追溯信息会被检索命中抹掉）
- 首次安装时日志目录不存在导致日志静默失败——插件初始化时自动 `mkdir`
- 内部审查会话的消息会触发纠正检测 / 记忆自动注入 / 轮次计数——现在通过内部会话 ID 集合同步跳过（无需异步查标题）
- 删除 `session.idle` 事件处理中重复的 `lastIdleSession` 检查

### Added
- 后台审查 prompt 注入已有记忆清单（≤4000 字符），审查模型不再重复保存已知事实，减少容量浪费
- `session.deleted` 事件清理会话级状态（轮次计数 / 注入去重缓存 / prefetch 频率 / 审查进度），防 Map 随会话数无限增长
- 回归测试新增 3 个断言（touch 刷新路径的元数据保留），18 → 21

### Changed
- 记忆自动注入块复用 `store.fenceBlock`，消除重复的 `<memory-context>` 围栏文本

## [0.2.0] - 2026-08-11

### Added
- **GitHub 直装支持**：`opencode plugin github:realchendahuang/opencode-hermes-memory` 一键安装（无需 npm），README 已更新为官方安装方式

### Changed
- package.json：新增 `exports["./server"]` 入口（OpenCode loader 优先解析）、`repository`/`bugs`/`homepage`/`author` 元数据、`engines.opencode` 兼容性声明
- CI：`bun install --frozen-lockfile` 保证可复现构建
- README 徽章：硬编码测试数改为 GitHub Actions 动态 CI 徽章

### Fixed
- 类型检查全绿：修复 `@opencode-ai/plugin` SDK 类型差异（`Message.summary` 对象化、`Part` 结构变化）与 `Target | "project"` 联合类型收窄问题
- `tests/regression.ts` 绝对路径改为相对路径

## [0.1.0] - 2026-08-11

### Added
- 首个开源版本，从个人配置目录提取
- 开源配套：README（中英双语）、CONTRIBUTING、SECURITY、CODE_OF_CONDUCT、Issue / PR 模板、CI（GitHub Actions）
- 分层记忆架构：L0 STANDING 注入 / L1 Markdown 真相源 / L2 token 打分检索
- 5 个记忆工具：`memory_search`、`memory_add`、`memory_replace`、`memory_remove`、`memory_history`
- 学习闭环：session.idle 后台审查（防抖 + 30 分钟全局频率限制）、压缩前 flush 审查、容量触顶自动 consolidate
- 纠正检测：规则匹配用户纠正 → 即时写入 failure 记忆
- 相关记忆自动注入：每轮最多 2 条、score ≥ 0.4、会话级去重
- 错误预取：bash 失败 → 注入相关失败教训（60s 频率限制）
- 双时态演化：被替换条目进入 `history.md`
- 日志轮转：1MB 阈值，保留最近 2 份旧日志
- 隔离回归测试：18 个断言，`setMemoryRoot` 完全隔离真实记忆
