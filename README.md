<div align="center">

# 🧠 Hermes Memory for OpenCode

**Layered persistent memory for your OpenCode agent — ported from [Hermes](https://github.com/weaigc/hermes)**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/github/v/release/realchendahuang/opencode-hermes-memory?sort=semver)](https://github.com/realchendahuang/opencode-hermes-memory/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/realchendahuang/opencode-hermes-memory/ci.yml?branch=main&label=CI)](https://github.com/realchendahuang/opencode-hermes-memory/actions)
[![OpenCode Plugin](https://img.shields.io/badge/OpenCode-Plugin-4B32C3)](https://opencode.ai)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

Give your OpenCode agent a **real memory** — user preferences, project conventions, past failures, and hard-won lessons survive across sessions. No vector database, no external services. Just Markdown files you can read, edit, and version-control.

</div>

---

## ✨ Features

| Layer | What it does |
|---|---|
| **L0 — Standing instructions** | `STANDING.md` hard rules injected into every session's system prompt |
| **L1 — Markdown truth source** | All memory lives in plain Markdown files — human-readable, hand-editable, git-friendly |
| **L2 — Retrieval** | `memory_search` tool with lightweight token-scored ranking (no vector DB needed) |
| **Learning loop** | Background LLM review on idle summarizes sessions into durable memories; rule-based correction detection saves corrections instantly; flush review before compaction; auto-consolidation at capacity |
| **Auto-injection** | Relevant memories are retrieved and injected into context on every user message (score ≥ 0.4, max 2/turn, deduplicated per session) |
| **Error prefetch** | When a shell command fails, related past-failure lessons are auto-injected into the next turn (Mem0-style) |
| **Bi-temporal evolution** | Replaced entries move to `history.md` — traceable, out of capacity, out of retrieval |

## 🚀 Quick Start (OpenCode V2)

> Requires **OpenCode ≥ 2.0** and `@opencode/plugin` 2.x. This is v0.4.0+ (native V2).
> Still on OpenCode 1.x? Use v0.3.x and the old `plugin` config.

### Install from GitHub (recommended)

```bash
opencode plugin add github:realchendahuang/opencode-hermes-memory
```

That's it — OpenCode downloads the plugin from GitHub, installs it, and registers it in your config automatically. Restart OpenCode and the plugin starts learning from your sessions.

### Manual install (local development)

```bash
git clone https://github.com/realchendahuang/opencode-hermes-memory.git
mkdir -p ~/.config/opencode/plugins
cp -R opencode-hermes-memory/hermes-memory.ts opencode-hermes-memory/hermes-memory-lib ~/.config/opencode/plugins/
```

Then add to the `plugins` array in `~/.config/opencode/opencode.json` (note: **`plugins`**, not `plugin`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "./plugins/hermes-memory.ts"
  ]
}
```

And install the dependency:

```bash
cd ~/.config/opencode
npm install @opencode/plugin
```

The plugin registers 5 tools (`memory_search`, `memory_add`, `memory_replace`, `memory_remove`, `memory_history`) and starts learning from your sessions automatically.

## 🧰 Memory Tools

| Tool | Description |
|---|---|
| `memory_search` | Search memories; filter by `target` (`memory`/`user`/`failure`/`project`) and `category` |
| `memory_add` | Add an entry (≤ 3000 chars, deduplicated) |
| `memory_replace` | Replace an entry; the old version moves to `history.md` |
| `memory_remove` | Remove an entry |
| `memory_history` | Read the evolution history of superseded entries |

## 📁 Data Layout

Memory lives in `~/.config/opencode/memory/`:

```
memory/
├── USER.md               # User profile — who the user is
├── MEMORY.md             # Global notes — environment facts, tool quirks
├── failures.md           # Categorized lessons (failure/correction/insight/preference/convention/tool-quirk)
├── STANDING.md           # Standing hard instructions (injected every session)
├── history.md            # Evolution history of superseded entries
└── projects-memory/<id>/ # Per-project memory, isolated by project
```

All files are plain Markdown — edit them directly whenever you like.

## 🏗️ Architecture

```
index.ts                # Re-export (V2 resolves plugin dirs via index.ts)
hermes-memory.ts          # Plugin entry (V2 native: Plugin.define + setup)
hermes-memory-lib/
├── store.ts              # MemoryStore: Markdown I/O, dedup, capacity, consolidation
├── learn.ts              # Learning loop: background review, flush review, correction detection
├── search.ts             # Token-scored retrieval
├── prompts.ts            # Prompts & constants (capacity limits, injection thresholds)
├── llm.ts                # V2 LLM channel via ctx.generate.text (no internal sessions)
├── paths.ts              # Path helpers (setMemoryRoot for test isolation)
└── tests/regression.ts   # Isolated regression tests
```

### Hooks (V2)

| V2 API | Purpose |
|---|---|
| `ctx.session.hook("context")` | Inject memory policy + STANDING + project memory into every model request |
| `ctx.session.hook("prompt")` | Correction detection, turn counting, relevant-memory auto-injection |
| `ctx.event.subscribe()` → `session.status` (idle) | Background learning review (10s debounce, 30-min global rate limit) |
| `ctx.session.hook("compaction")` | Flush review before context compaction |
| `ctx.tool.hook("execute.after")` | Bash error detection → failure-memory prefetch |

V1 mapping: `experimental.chat.system.transform` → `context`, `chat.message` → `prompt`,
`experimental.session.compacting` → `compaction`, `event(session.idle)` → `event.subscribe`
(`session.status` idle; `session.idle` is deprecated upstream but kept as fallback),
`tool.execute.after` unchanged in name (V2 tool is `shell`, not `bash`), internal-session LLM → `ctx.generate.text`.

## ⚙️ Configuration

| Source | Key | Default | Description |
|---|---|---|---|
| Plugin options | `hermesNudgeInterval` | `10` | Turns between background reviews (V2 `plugins: [{package, options}]`) |
| Env var | `HERMES_NUDGE_INTERVAL` | `10` | Same, fallback when no option is set |

```jsonc
{
  "plugins": [
    { "package": "./plugins/hermes-memory.ts", "options": { "hermesNudgeInterval": 10 } }
  ]
}
```

## 🧪 Development

```bash
# Run the isolated suites (never touches real memory files)
bun run test

# Individual suites
bun run hermes-memory-lib/tests/regression.ts
bun run hermes-memory-lib/tests/v2-smoke.ts

# Type-check
bunx tsc --noEmit

# Lint
bun run lint
```

The test suite uses `setMemoryRoot(tmpdir)` to fully isolate from your real memory.

## 🤝 Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines, and check the [open issues](https://github.com/realchendahuang/opencode-hermes-memory/issues) for ideas.

## 📜 License

[MIT](LICENSE) © [realchendahuang](https://github.com/realchendahuang)

---

## ⭐ Star History

[![Star History Chart](https://api.star-history.com/svg?repos=realchendahuang/opencode-hermes-memory&type=Date)](https://star-history.com/#realchendahuang/opencode-hermes-memory&Date)
