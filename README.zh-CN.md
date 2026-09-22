<div align="center">

# 🧠 Hermes Memory for OpenCode

**OpenCode 的分层持久记忆插件 — 移植自 [Hermes](https://github.com/weaigc/hermes) agent**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/github/v/release/realchendahuang/opencode-hermes-memory?sort=semver)](https://github.com/realchendahuang/opencode-hermes-memory/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/realchendahuang/opencode-hermes-memory/ci.yml?branch=main&label=CI)](https://github.com/realchendahuang/opencode-hermes-memory/actions)
[![OpenCode Plugin](https://img.shields.io/badge/OpenCode-Plugin-4B32C3)](https://opencode.ai)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

让你的 OpenCode agent 拥有**真正的记忆**——用户偏好、项目约定、历史教训、踩过的坑，跨会话持久保存。无需向量数据库，无需外部服务，全部是你可以直接阅读、手改、纳入版本管理的 Markdown 文件。

</div>

---

## ✨ 特性

| 层级 | 作用 |
|---|---|
| **L0 — 常驻指令** | `STANDING.md` 硬规则，每次会话注入 system prompt |
| **L1 — Markdown 真相源** | 记忆全部存为纯 Markdown——人类可读、可手改、可 git 管理 |
| **L2 — 检索** | `memory_search` 工具，基于 token 打分的轻量检索（无需向量库） |
| **学习闭环** | 会话空闲时后台 LLM 审查自动沉淀记忆；规则检测纠正即时入库；压缩前 flush 审查；容量触顶自动 consolidate |
| **自动注入** | 每条用户消息到达时自动检索相关记忆注入上下文（score ≥ 0.4，每轮最多 2 条，会话级去重） |
| **错误预取** | shell 命令失败时，自动注入相关历史失败教训（Mem0 风格） |
| **双时态演化** | 被替换的旧条目进入 `history.md`——可追溯、不占容量、不参与检索 |

## 🚀 快速开始（OpenCode V2）

> 需要 **OpenCode ≥ 2.0** 与 `@opencode/plugin` 2.x。这是 v0.4.0+（原生 V2）。
> 还在用 OpenCode 1.x？请用 v0.3.x 与旧版 `plugin` 配置。

### 从 GitHub 安装（推荐）

```bash
opencode plugin add github:realchendahuang/opencode-hermes-memory
```

一条命令搞定——OpenCode 自动从 GitHub 下载插件、安装并写入配置。重启 OpenCode 后插件即开始从你的会话中学习。

> **提示**：加 `-g` 参数可全局安装（所有项目生效），不加则只对当前项目生效：
>
> ```bash
> opencode plugin add -g github:realchendahuang/opencode-hermes-memory
> ```

### 手动安装（本地开发用）

```bash
git clone https://github.com/realchendahuang/opencode-hermes-memory.git
mkdir -p ~/.config/opencode/plugins
cp -R opencode-hermes-memory/hermes-memory.ts opencode-hermes-memory/hermes-memory-lib ~/.config/opencode/plugins/
```

然后在 `~/.config/opencode/opencode.json` 的 `plugins` 数组中加入（注意是 **`plugins`**，不是 `plugin`）：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "./plugins/hermes-memory.ts"
  ]
}
```

并安装依赖：

```bash
cd ~/.config/opencode
npm install @opencode/plugin
```

插件会注册 5 个工具（`memory_search`、`memory_add`、`memory_replace`、`memory_remove`、`memory_history`），并自动开始从你的会话中学习。

## 🧰 记忆工具

| 工具 | 说明 |
|---|---|
| `memory_search` | 检索记忆，支持 `target`（memory/user/failure/project）与 `category` 过滤 |
| `memory_add` | 新增条目（单条 ≤ 3000 字符，自动去重） |
| `memory_replace` | 替换条目，旧版自动进 `history.md` |
| `memory_remove` | 删除条目 |
| `memory_history` | 查看被替换条目的演化历史 |

## 📁 数据位置

记忆数据存放在 `~/.config/opencode/memory/`：

```
memory/
├── USER.md               # 用户画像——who the user is
├── MEMORY.md             # 全局笔记——环境事实、工具怪癖
├── failures.md           # 分类教训（failure/correction/insight/preference/convention/tool-quirk）
├── STANDING.md           # 常驻硬指令（每次会话注入）
├── history.md            # 被替换条目的演化历史
└── projects-memory/<id>/ # 按项目隔离的记忆
```

全部是纯 Markdown，随时可以直接手改。

## 🏗️ 架构

```
index.ts                # Re-export（V2 通过 index.ts 解析插件目录）
hermes-memory.ts          # 插件入口（V2 原生：Plugin.define + setup）
hermes-memory-lib/
├── store.ts              # MemoryStore：Markdown 读写、查重、容量、consolidate
├── learn.ts              # 学习闭环：后台审查、flush 审查、纠正检测
├── search.ts             # token 打分检索
├── prompts.ts            # 提示词与常量（容量上限、注入阈值等）
├── llm.ts                # V2 LLM 通道（ctx.generate.text，无内部会话）
├── paths.ts              # 路径函数（setMemoryRoot 测试隔离）
└── tests/                # regression.ts（隔离回归）+ v2-smoke.ts（mock ctx 烟雾测试）
```

### 事件钩子（V2）

| V2 API | 作用 |
|---|---|
| `ctx.session.hook("context")` | 每次模型请求注入记忆策略 + STANDING + 项目记忆 |
| `ctx.session.hook("prompt")` | 纠正检测、轮次计数、相关记忆自动注入 |
| `ctx.event.subscribe()` → `session.status`（idle） | 后台学习审查（10s 防抖，30 分钟全局频率限制） |
| `ctx.session.hook("compaction")` | 压缩前 flush 审查 |
| `ctx.tool.hook("execute.after")` | shell 错误检测 → 失败教训预取 |

V1 映射：`experimental.chat.system.transform` → `context`、`chat.message` → `prompt`、
`experimental.session.compacting` → `compaction`、`event(session.idle)` → `event.subscribe`
（`session.status` idle 为主，`session.idle` 在上游已 deprecated，仅作 fallback）、
`tool.execute.after` 名称不变（V2 工具名为 `shell`，不是 `bash`），内部会话 LLM → `ctx.generate.text`。

## ⚙️ 配置

| 来源 | 键 | 默认 | 说明 |
|---|---|---|---|
| Plugin options | `hermesNudgeInterval` | `10` | 后台审查间隔轮次（V2 `plugins: [{package, options}]`） |
| 环境变量 | `HERMES_NUDGE_INTERVAL` | `10` | 同上，无 option 时的 fallback |

```jsonc
{
  "plugins": [
    { "package": "./plugins/hermes-memory.ts", "options": { "hermesNudgeInterval": 10 } }
  ]
}
```

## 🧪 开发

```bash
# 运行隔离回归测试（绝不触碰真实记忆文件）
bun run test

# 单独运行
bun run hermes-memory-lib/tests/regression.ts
bun run hermes-memory-lib/tests/v2-smoke.ts

# 类型检查
bunx tsc --noEmit

# Lint
bun run lint
```

测试通过 `setMemoryRoot(临时目录)` 完全隔离，不触碰真实记忆。

## 🤝 贡献

欢迎贡献！请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，并查看 [open issues](https://github.com/realchendahuang/opencode-hermes-memory/issues) 找灵感。

## 📜 License

[MIT](LICENSE) © [realchendahuang](https://github.com/realchendahuang)

---

## ⭐ Star History

[![Star History Chart](https://api.star-history.com/svg?repos=realchendahuang/opencode-hermes-memory&type=Date)](https://star-history.com/#realchendahuang/opencode-hermes-memory&Date)
