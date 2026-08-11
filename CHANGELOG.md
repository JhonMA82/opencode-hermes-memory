# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added
- 项目开源：README（中英双语）、CONTRIBUTING、SECURITY、CODE_OF_CONDUCT
- 项目元数据：package.json、tsconfig.json
- CI：GitHub Actions 测试 workflow
- Issue / PR 模板
- **GitHub 直装支持**：`opencode plugin github:realchendahuang/opencode-hermes-memory` 一键安装（无需 npm），README 已更新为官方安装方式

### Fixed
- 类型检查全绿：修复 `@opencode-ai/plugin` SDK 类型差异（`Message.summary` 对象化、`Part` 结构变化）与 `Target | "project"` 联合类型收窄问题
- `tests/regression.ts` 绝对路径改为相对路径（`import.meta.url` 无关，直接相对引用）

## [0.1.0] - 2026-08-11

### Added
- 首个开源版本，从个人配置目录提取
- 分层记忆架构：L0 STANDING 注入 / L1 Markdown 真相源 / L2 token 打分检索
- 5 个记忆工具：`memory_search`、`memory_add`、`memory_replace`、`memory_remove`、`memory_history`
- 学习闭环：session.idle 后台审查（防抖 + 30 分钟全局频率限制）、压缩前 flush 审查、容量触顶自动 consolidate
- 纠正检测：规则匹配用户纠正 → 即时写入 failure 记忆
- 相关记忆自动注入：每轮最多 2 条、score ≥ 0.4、会话级去重
- 错误预取：bash 失败 → 注入相关失败教训（60s 频率限制）
- 双时态演化：被替换条目进入 `history.md`
- 日志轮转：1MB 阈值，保留最近 2 份旧日志
- 隔离回归测试：18 个断言，`setMemoryRoot` 完全隔离真实记忆
