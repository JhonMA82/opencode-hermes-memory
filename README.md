# Hermes Memory for OpenCode

OpenCode 的分层持久记忆插件。从 [Hermes agent](https://github.com/weaigc/hermes) 的记忆机制移植而来（经 pi-hermes-memory 二次移植），为 OpenCode 提供跨会话的持久记忆：用户偏好、项目约定、历史教训、工具怪癖。

## 特性

- **L0 常驻指令** — `STANDING.md` 硬指令，每次会话注入 system prompt
- **L1 Markdown 真相源** — 记忆以纯 Markdown 文件存储，人类可读、可手改、可 git 管理
- **L2 检索** — `memory_search` 工具，基于 token 打分的轻量检索（无需向量库）
- **学习闭环** — 会话空闲时后台 LLM 审查自动沉淀记忆；规则检测纠正（correction）即时入库；压缩前 flush 审查；容量触顶自动 consolidate
- **自动注入** — 用户消息到达时自动检索相关记忆注入上下文（阈值 0.4，每轮最多 2 条，会话级去重）
- **错误预取** — 检测到 bash 错误时自动注入相关失败教训
- **双时态演化** — 被替换的旧条目进入 `history.md`，不占容量、不参与检索

## 安装

### 1. 复制插件

```bash
git clone https://github.com/realchendahuang/opencode-hermes-memory.git
cp -R opencode-hermes-memory/hermes-memory.ts opencode-hermes-memory/hermes-memory-lib ~/.config/opencode/plugins/
```

### 2. 注册插件

在 `~/.config/opencode/opencode.json` 的 `plugin` 数组中加入：

```json
{
  "plugin": [
    "./plugins/hermes-memory.ts"
  ]
}
```

### 3. 安装依赖

```bash
cd ~/.config/opencode && npm install @opencode-ai/plugin
```

重启 OpenCode 即可。

## 记忆工具

插件注册 5 个工具：

| 工具 | 说明 |
|---|---|
| `memory_search` | 检索记忆，支持 `target`（memory/user/failure/project）与 `category` 过滤 |
| `memory_add` | 新增条目（单条 ≤3000 字符，重复自动去重） |
| `memory_replace` | 替换条目，旧版进 `history.md` |
| `memory_remove` | 删除条目 |
| `memory_history` | 查看被替换条目的演化历史 |

## 数据位置

记忆数据存放在 `~/.config/opencode/memory/`：

```
memory/
├── USER.md               # 用户画像（who the user is）
├── MEMORY.md             # 全局笔记（环境事实、工具怪癖）
├── failures.md           # 分类教训（failure/correction/insight/preference/convention/tool-quirk）
├── STANDING.md           # 常驻硬指令（每次会话注入）
├── history.md            # 被替换条目的演化历史
└── projects-memory/<id>/ # 按项目隔离的记忆
```

所有文件都是纯 Markdown，可直接手改。

## 架构

```
hermes-memory.ts          # 插件入口：事件钩子、工具注册、注入逻辑
hermes-memory-lib/
├── store.ts              # MemoryStore：Markdown 读写、查重、容量、consolidate
├── learn.ts              # 学习闭环：后台审查、flush 审查、纠正检测、consolidate
├── search.ts             # token 打分检索
├── prompts.ts            # 提示词与常量（容量上限、注入阈值等）
├── llm.ts                # 内部会话 LLM 通道（无直接 completion API 的替代方案）
├── paths.ts              # 路径函数（支持 setMemoryRoot 测试隔离）
└── tests/regression.ts   # 隔离回归测试
```

### 事件钩子

- `experimental.chat.system.transform` — 注入记忆策略 + STANDING + 项目记忆
- `chat.message` — 纠正检测、轮次计数、相关记忆自动注入
- `session.idle` — 后台学习审查（防抖 10s，全局 30 分钟频率限制）
- `experimental.session.compacting` — 压缩前 flush 审查

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `HERMES_NUDGE_INTERVAL` | `10` | 后台审查间隔（轮次） |

## 测试

```bash
bun run hermes-memory-lib/tests/regression.ts
```

测试通过 `setMemoryRoot(临时目录)` 完全隔离，不触碰真实记忆文件。

## License

MIT
