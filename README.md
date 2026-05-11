# choda-deck

> **Persistent memory + orchestration layer for [Claude Code](https://docs.claude.com/claude-code).**
> Tasks, sessions, conversations, decisions, and inbox — all backed by SQLite, all reachable through MCP tools.

[![npm version](https://img.shields.io/npm/v/choda-deck.svg)](https://www.npmjs.com/package/choda-deck)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

---

## What is choda-deck?

A pure-Node MCP server that turns Claude Code from a stateless chat into a **stateful collaborator**.

Claude can:
- 📋 Track tasks with acceptance criteria, status, and labels
- 🧵 Bind work sessions to tasks — checkpoint progress, resume next time with full context
- 💬 Hold structured conversations with decisions logged
- 📥 Capture mid-flow ideas to an inbox, research them later, convert to tasks
- 📚 Maintain a knowledge layer (ADRs / decision logs) with staleness tracking
- 💾 Auto-backup daily, restore on demand

Everything lives in a single SQLite file. No cloud, no SaaS, no telemetry.

## Why?

Working with Claude Code across many days hits the same walls:

| Pain | Without choda-deck | With choda-deck |
|---|---|---|
| Lost task list | Scattered across markdown / TODO comments / chat history | One queryable source of truth |
| Lost context between sessions | Re-explain what you were doing last time | `session_resume` loads task body + AC + last checkpoint |
| Decisions disappear into chat | Scroll back, hope you find it | `conversation_decide` + `knowledge_create` log decisions next to code |
| Ideas dropped mid-flow | Forgotten or pile up in scratch files | `inbox_add` — research/convert/archive later |
| ADRs drift from code | Manual review, never happens | `knowledge_verify` flags stale ADRs via `refs[]` |

choda-deck is the **memory layer** Claude wishes it had built-in.

## Install

```bash
npm install -g choda-deck
# or run on demand
npx choda-deck
```

Requires Node.js >= 20.

## Wire it into Claude Code

Add to `.claude.json` (user-level) or `.mcp.json` (project-level):

```json
{
  "mcpServers": {
    "choda-tasks": {
      "command": "npx",
      "args": ["-y", "choda-deck"],
      "env": {
        "CHODA_DATA_DIR": "/absolute/path/to/data",
        "CHODA_CONTENT_ROOT": "/absolute/path/to/your/notes-or-vault"
      }
    }
  }
}
```

Restart Claude Code → the `choda-tasks` MCP server is online.

## CLI

`choda-deck` ships a read-only CLI that talks to the same SQLite store directly — no AI in the loop, no MCP roundtrip. Use it to verify state, script automations, or pipe to `jq`.

```bash
choda-deck --help                                # show all subcommands
choda-deck task list --status TODO --json        # script-friendly
choda-deck task show TASK-669                    # body + linked conversations
choda-deck inbox list --project choda-deck
choda-deck knowledge list
choda-deck knowledge show ADR-020-embedding-architecture
choda-deck project context choda-deck            # AI's session_start view
choda-deck mcp serve                             # start the MCP stdio server
```

Pass `--json` to any read command for machine-readable output. Plain text is the default for humans.

### Reading freshness

The CLI opens SQLite in WAL mode for shared reads. While the MCP server is actively writing, a CLI read may see a snapshot from a few seconds ago — re-run after 1-2s if state looks stale. See knowledge entry `sqlite-wal-read-consistency` for details.

## Tools

All tools are namespaced `mcp__choda-tasks__<name>`. Claude calls them on your behalf — you never invoke them directly.

| Domain | Tools | What it does |
|---|---|---|
| **Project** | `project_add`, `project_list`, `project_context` | Multi-project setup. Each project has its own task list and metadata. |
| **Workspace** | `workspace_add`, `workspace_list`, `workspace_archive`, `workspace_remove` | Sub-scope inside a project (e.g. `frontend`, `backend`, `infra`). Knowledge entries can be scoped to a workspace. |
| **Task** | `task_create`, `task_list`, `task_update`, `task_context` | TODO → READY → IN-PROGRESS → DONE/BLOCKED. Each task has body + acceptance criteria + labels + priority. |
| **Session** | `session_start`, `session_checkpoint`, `session_end`, `session_resume`, `session_list` | Bind a work session to a task. Checkpoint progress so the next session resumes with full context. |
| **Conversation** | `conversation_open`, `conversation_add`, `conversation_decide`, `conversation_close`, `conversation_reopen`, `conversation_list`, `conversation_read`, `conversation_poll` | Structured threads (e.g. FE/BE alignment, ADR debate). `decide` logs the resolution. |
| **Inbox** | `inbox_add`, `inbox_research`, `inbox_convert`, `inbox_ready`, `inbox_archive`, `inbox_list`, `inbox_get`, `inbox_update` | Capture-now, decide-later. Items move `raw` → `researching` → `ready` → `converted` (to a task) or `archived`. |
| **Knowledge** | `knowledge_create`, `knowledge_list`, `knowledge_get`, `knowledge_search`, `knowledge_update`, `knowledge_verify`, `knowledge_delete` | ADRs / decision logs with frontmatter. `refs[]` tracks implementation files + commit SHAs → staleness banner when code drifts. |
| **Backup** | `backup_create`, `backup_list`, `backup_restore` | Daily auto-backup of the SQLite DB. Manual create + restore when you need to roll back. |

## Common workflows

### 1. Task-driven session

```
You    : "Let's work on TASK-123"
Claude : (task_context TASK-123) → loads body + AC
Claude : (session_start TASK-123) → binds session
You    : (work happens)
Claude : (session_checkpoint "finished part 1, hit X issue")
You    : "stop here, continue tomorrow"
Claude : (session_end)

— next day —
You    : "resume yesterday's work"
Claude : (session_resume) → re-reads task body + last checkpoint
```

### 2. Capture without breaking flow

```
You    : "While we're here — idea: split this module into two"
Claude : (inbox_add content="split foo module → two") — back to current work
```

Later:
```
You    : "show me the inbox"
Claude : (inbox_list) → 12 raw items
You    : "research INBOX-008"
Claude : (inbox_research) → reads codebase, writes findings, sets status=ready
You    : "convert it"
Claude : (inbox_convert) → creates TASK-456 with body from research
```

### 3. Decision log next to code

```
You    : "should we use sqlite-vec or qdrant for embeddings?"
Claude : (conversation_open "embedding store choice")
Claude : (analyzes both, posts trade-offs)
You    : "go sqlite-vec for now"
Claude : (conversation_decide "sqlite-vec — brute KNN fine at our scale")
Claude : (knowledge_create ADR-020 with refs to src/embeddings/*.ts)
Claude : (conversation_close)
```

Three months later, when you edit `src/embeddings/`:
```
Claude : (knowledge_verify) → flags ADR-020 as potentially stale (refs SHA mismatch)
```

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `CHODA_DATA_DIR` | _required_ | SQLite DB, artifacts, and backups directory. Created on first run. |
| `CHODA_CONTENT_ROOT` | _optional_ | Root for knowledge / vault content lookup. |

### Data layout

```
$CHODA_DATA_DIR/
├── database/choda-deck.db        ← single source of truth
├── artifacts/<sessionId>/        ← per-session scratch
└── backups/choda-deck-<date>.db  ← auto daily, retained
```

## Architecture

- **SQLite** (`better-sqlite3`) — single source of truth, file-based, no daemon
- **MCP stdio** — AI interaction layer (Anthropic's [Model Context Protocol](https://modelcontextprotocol.io))
- **Pure Node runtime** — no Electron, no PTY, no native deps beyond `better-sqlite3`
- **Windows-first**, but runs on macOS and Linux

See [`docs/architecture.md`](https://github.com/butterngo/choda-deck/blob/main/docs/architecture.md) for the full layout, and ADRs in [`docs/knowledge/`](https://github.com/butterngo/choda-deck/tree/main/docs/knowledge) for design decisions.

## Status

`0.1.0` — early, dogfooded daily by the author. API may move before `1.0`. Issues + PRs welcome.

## License

MIT — see [LICENSE](./LICENSE).
