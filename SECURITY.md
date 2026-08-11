# Security Policy

## 报告安全漏洞

请**不要**在 GitHub Issues 中公开提交安全漏洞。

请通过以下方式私下报告：

- 在 GitHub 上创建 [Private vulnerability report](https://github.com/realchendahuang/opencode-hermes-memory/security/advisories/new)
- 或直接联系维护者

## 处理流程

1. 维护者确认漏洞后，会在 48 小时内回复
2. 修复会尽快发布，并同步在 [Security Advisories](https://github.com/realchendahuang/opencode-hermes-memory/security/advisories) 公开

## 安全注意事项

本插件会读取并写入 `~/.config/opencode/memory/` 下的记忆文件，并可能调用 LLM 进行后台学习。请注意：

- 记忆文件可能包含敏感信息，请勿将 `memory/` 目录提交到公开仓库
- 插件日志位于 `~/.local/share/opencode/log/hermes-memory.log`，同样可能包含会话摘要
- 后台学习会消耗 token，可通过 `HERMES_NUDGE_INTERVAL` 环境变量调低频率
