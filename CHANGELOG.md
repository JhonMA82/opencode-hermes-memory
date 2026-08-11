# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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
