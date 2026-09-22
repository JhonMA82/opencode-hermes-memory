# Contributing to Hermes Memory for OpenCode

首先感谢你愿意为这个项目贡献代码！以下指南帮助你快速上手。

## 开发环境

- [Bun](https://bun.sh) ≥ 1.0（测试与运行依赖）
- [OpenCode](https://opencode.ai)（本地验证插件行为）

## 项目结构

```
index.ts                # Re-export（V2 通过 index.ts 解析插件目录）
hermes-memory.ts          # 插件入口（V2 原生：Plugin.define + setup）
hermes-memory-lib/
├── store.ts              # MemoryStore：Markdown 读写、查重、容量、consolidate
├── learn.ts              # 学习闭环：后台审查、flush 审查、纠正检测
├── search.ts             # token 打分检索
├── prompts.ts            # 提示词与常量
├── llm.ts                # V2 LLM 通道（ctx.generate.text）
├── paths.ts              # 路径函数
└── tests/                # regression.ts（隔离回归）+ v2-smoke.ts（V2 烟雾测试）
```

## 开发流程

1. **Fork 并 clone** 本仓库
2. **创建分支**：`git checkout -b feat/your-feature` 或 `fix/your-fix`
3. **写代码**，遵循现有风格（TypeScript、中文注释、错误处理不静默吞掉关键路径）
4. **加测试**：新功能请在 `hermes-memory-lib/tests/regression.ts`（或 `v2-smoke.ts`，如涉 V2 钩子/工具）中补充断言
5. **跑测试**：

   ```bash
   bun run test
   ```

   测试必须全绿（regression 25+ 断言，v2-smoke 18 断言）。
6. **类型检查**：

   ```bash
   bunx tsc --noEmit
   ```
7. **Lint**：

   ```bash
   bun run lint
   ```
7. **提交**：写清晰的 commit message（参考 [Conventional Commits](https://www.conventionalcommits.org/) 风格，如 `feat: ...` / `fix: ...`）
8. **发起 PR**：描述改动内容、动机、测试结果

## 代码规范

- TypeScript，严格模式（`strict: true`）
- 注释用中文，代码标识符用英文
- 不引入新的运行时依赖（保持零依赖，仅 `@opencode/plugin`）
- 记忆数据格式变更必须向后兼容（用户已有 Markdown 文件）
- 涉及 LLM 调用的逻辑必须考虑频率控制，避免烧 token
- 项目名（`project` 参数）仅允许字母/数字/`.`/`-`/`_`，防止路径穿越

## 测试隔离原则

测试必须通过 `setMemoryRoot(临时目录)` 完全隔离，**绝不触碰**真实记忆文件（`~/.config/opencode/memory/`）。

## 提交 PR 前检查清单

- [ ] 测试全绿
- [ ] 类型检查通过
- [ ] 无新增运行时依赖
- [ ] 记忆格式向后兼容
- [ ] README 已同步（如有行为变更）

## 问题与讨论

- Bug 报告 / 功能建议：开 [issue](https://github.com/realchendahuang/opencode-hermes-memory/issues)
- 安全问题：见 [SECURITY.md](SECURITY.md)，请勿公开提交
