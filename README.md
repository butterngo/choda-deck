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
- 🔍 Trace bugs as structured investigations — hypotheses, evidence, root cause — that survive across sessions
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

## Wire it into your MCP client

choda-deck speaks stock MCP stdio — works with any client that supports the protocol. Pick the one you use:

### Claude Code

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

### Claude Desktop

Edit `claude_desktop_config.json` (same `mcpServers` schema as above):

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

Quit + reopen Claude Desktop. The hammer icon shows `choda-tasks` connected.

### GitHub Copilot (VS Code)

Create `.vscode/mcp.json` in your workspace (or add to User Settings):

```json
{
  "servers": {
    "choda-tasks": {
      "type": "stdio",
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

Note: Copilot uses `servers` (not `mcpServers`) and requires `"type": "stdio"`. Reload VS Code window → tools appear in Copilot Chat under agent mode.

### Other clients (Cursor, Continue, Zed, …)

Any MCP-compatible client works. Use the `command` / `args` / `env` triple — drop it into whatever the client calls its MCP config block.

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
| **Workspace** | `workspace_add`, `workspace_list`, `workspace_archive` | Sub-scope inside a project (e.g. `frontend`, `backend`, `infra`). Knowledge entries can be scoped to a workspace. |
| **Task** | `task_create`, `task_list`, `task_update`, `task_context` | TODO → READY → IN-PROGRESS → DONE/BLOCKED. Each task has body + acceptance criteria + labels + priority. |
| **Session** | `session_start`, `session_checkpoint`, `session_end`, `session_resume`, `session_list` | Bind a work session to a task. Checkpoint progress so the next session resumes with full context. |
| **Conversation** | `conversation_open`, `conversation_add`, `conversation_decide`, `conversation_close`, `conversation_reopen`, `conversation_list`, `conversation_read`, `conversation_poll` | Structured threads (e.g. FE/BE alignment, ADR debate). `decide` logs the resolution. |
| **Inbox** | `inbox_add`, `inbox_research`, `inbox_convert`, `inbox_ready`, `inbox_archive`, `inbox_list`, `inbox_get`, `inbox_update` | Capture-now, decide-later. Items move `raw` → `researching` → `ready` → `converted` (to a task) or `archived`. |
| **Knowledge** | `knowledge_create`, `knowledge_list`, `knowledge_get`, `knowledge_search`, `knowledge_update`, `knowledge_verify`, `knowledge_delete` | ADRs / decision logs with frontmatter. `refs[]` tracks implementation files + commit SHAs → staleness banner when code drifts. |
| **Investigation** | `investigation_start`, `investigation_add_hypothesis`, `investigation_set_hypothesis_status`, `investigation_add_evidence`, `investigation_resolve`, `investigation_get` | Nonlinear debugging container (ADR-035). Hypotheses (ruled-out branches kept) + typed evidence persist across sessions; `resolve` drafts a knowledge gotcha for reuse. stdio-only. |
| **Backup** | `backup_create`, `backup_list`, `backup_restore` | Daily auto-backup of the SQLite DB. Manual create + restore when you need to roll back. |
| **Ops** | `stats_report`, `cleanup_worktree_orphans` | Tool-usage telemetry (per-tool calls / error rate / dead-in-window) + worktree GC. |

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
| `CHODA_BACKEND` | `sqlite` | Storage backend (ADR-030). `sqlite` (local file) or `postgres` (remote, k8s-friendly). |
| `CHODA_PG_URL` | _required when `CHODA_BACKEND=postgres`_ | Postgres connection string (e.g. `postgres://user:pass@host:5432/db`). |
| `CHODA_PG_POOL_SIZE` | `10` | Postgres connection pool max size. Tune for concurrent HTTP requests. |
| `CHODA_EMBEDDING_PROVIDER` | `local` | `local` (transformers.js MiniLM-L6) or `noop` (disable embedding-backed search). |

### Data layout (SQLite)

```
$CHODA_DATA_DIR/
├── database/choda-deck.db        ← single source of truth
├── artifacts/<sessionId>/        ← per-session scratch
└── backups/choda-deck-<date>.db  ← auto daily, retained
```

### Postgres backend

The Postgres adapter is full-feature parity with SQLite — all `mcp__choda-tasks__*` tools work against either backend. Use Postgres when running the MCP HTTP transport in k8s (ADR-026 + ADR-030).

**Local dev** with the shipped `docker-compose.yml`:

```bash
docker compose up -d                             # boots pgvector/pgvector:pg16 on :5432
export CHODA_BACKEND=postgres
export CHODA_PG_URL="postgres://choda:choda@localhost:5432/choda"
pnpm run mcp:http                                # schema migrates on first connect
```

**k8s** — minimal `Deployment` + `Secret` shape:

```yaml
apiVersion: v1
kind: Secret
metadata: { name: choda-pg }
type: Opaque
stringData:
  CHODA_PG_URL: postgres://choda:CHANGEME@choda-pg.default.svc.cluster.local:5432/choda
  MCP_HTTP_TOKEN: REPLACE_WITH_BASE64URL_32_BYTES
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: choda-deck }
spec:
  replicas: 1
  template:
    spec:
      containers:
        - name: choda
          image: ghcr.io/your-org/choda-deck:latest
          env:
            - { name: CHODA_BACKEND,  value: postgres }
            - { name: MCP_TRANSPORT,  value: http }
            - { name: MCP_HTTP_BIND,  value: 0.0.0.0 }
          envFrom:
            - secretRef: { name: choda-pg }
          ports:
            - containerPort: 7337
          readinessProbe:
            httpGet: { path: /healthz, port: 7337 }
```

Bring your own Postgres (Cloud SQL, RDS, managed) or run a sidecar `StatefulSet` with the `pgvector/pgvector:pg16` image. Migrations and the pgvector extension setup are idempotent — they run automatically inside `initializeAsync()` on every boot.

**Migration from existing SQLite data** — one-shot script:

```bash
CHODA_PG_URL="postgres://choda:choda@localhost:5432/choda" \
  node scripts/migrate-sqlite-to-postgres.mjs \
    --sqlite $CHODA_DATA_DIR/database/choda-deck.db [--dry-run]
```

The script is idempotent (skips tables that already have rows; pass `--force` to wipe + reload). Embedding vectors are NOT copied — re-run `scripts/backfill-embeddings.mjs` against the Postgres backend after migration to rebuild them.

Cross-device sync is **partial** as of `0.3.0`: read-only pull (ADR-030 Phase 2) ships — `choda-deck sync pull` drains a remote MCP's `GET /sync/since` into the local SQLite file. Full bidirectional pending-ops sync (write-through + last-writer-wins, Phases 3–6) is **not** in this release; for writes, pick `CHODA_BACKEND` per process.

## Architecture

- **SQLite** (`better-sqlite3`) — single source of truth, file-based, no daemon
- **MCP stdio** — AI interaction layer (Anthropic's [Model Context Protocol](https://modelcontextprotocol.io))
- **Pure Node runtime** — no Electron, no PTY, no native deps beyond `better-sqlite3`
- **Windows-first**, but runs on macOS and Linux

See [`docs/architecture.md`](https://github.com/butterngo/choda-deck/blob/main/docs/architecture.md) for the full layout, and ADRs in [`docs/knowledge/`](https://github.com/butterngo/choda-deck/tree/main/docs/knowledge) for design decisions.

## Changelog

Full notes per release: [GitHub Releases](https://github.com/butterngo/choda-deck/releases).

### 0.3.0
- **Investigation** — first-class, stdio-only container for nonlinear debugging (hypotheses + typed evidence across sessions; `resolve` drafts a knowledge gotcha). 6 new tools (ADR-035).
- **Cross-device sync foundation** — sync-metadata columns + Lamport clock (Phase 1) and read-only pull `choda-deck sync pull` (Phase 2, ADR-030).
- **`session_cancel`** — retire a session without marking its task DONE.
- Auto-derived `modifies` TOUCHES at `session_end`; HTTP keep-alive teardown fix; the CLI bin now actually ships in the npm tarball.

## Status

`0.3.0` — early, dogfooded daily by the author. API may move before `1.0`. Issues + PRs welcome.

## License

MIT — see [LICENSE](./LICENSE).
