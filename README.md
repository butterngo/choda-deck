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
npx -y choda-deck mcp serve
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
      "args": ["-y", "choda-deck", "mcp", "serve"],
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
      "args": ["-y", "choda-deck", "mcp", "serve"],
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

`choda-deck` is first and foremost an MCP server — the binary exposes two commands:

```bash
choda-deck mcp serve     # start the MCP server (stdio by default; MCP_TRANSPORT=http for Streamable HTTP)
choda-deck sync pull     # drain a remote MCP's changes into the local SQLite DB (ADR-030 Phase 2)
choda-deck --help
choda-deck --version
```

`mcp serve` is what your MCP client launches under the hood — the `npx -y choda-deck mcp serve` config shown above resolves to it. `sync pull` performs the read-only cross-device pull (see [Postgres backend](#postgres-backend)). There is no separate query CLI — read state through the MCP tools (Claude) or the SQLite file directly.

## Tools

All tools are namespaced `mcp__choda-tasks__<name>`. Claude calls them on your behalf — you never invoke them directly. Over the HTTP transport only a narrow read + capture subset is exposed (see [HTTP transport](#http-transport)); the full surface below is stdio-only.

| Domain | Tools | What it does |
|---|---|---|
| **Project** | `project_add`, `project_list`, `project_context` | Multi-project setup. Each project has its own task list and metadata. |
| **Workspace** | `workspace_add`, `workspace_list`, `workspace_archive` | Sub-scope inside a project (e.g. `frontend`, `backend`, `infra`). Knowledge + tasks can be scoped to a workspace. |
| **Task** | `task_create`, `task_list`, `task_update`, `task_context`, `ac_check` | TODO → READY → IN-PROGRESS → DONE/CANCELLED. Each task has body + acceptance criteria + labels + priority. `ac_check` ticks one AC item with evidence. |
| **Session** | `session_start`, `session_checkpoint`, `session_end`, `session_resume`, `session_cancel`, `session_list`, `session_event_add`, `session_event_list` | Bind a work session to a task. Checkpoint progress so the next session resumes with full context; `session_cancel` retires a session without completing its task. |
| **Conversation** | `conversation_open`, `conversation_add`, `conversation_decide`, `conversation_signoff`, `conversation_mark_read`, `conversation_list`, `conversation_read`, `conversation_poll` | Structured threads (e.g. FE/BE alignment, ADR debate). Status is `open` → `decided`; `decide` logs the resolution, `signoff` records agreement. |
| **Inbox** | `inbox_add`, `inbox_research`, `inbox_ready`, `inbox_convert`, `inbox_archive`, `inbox_list`, `inbox_get`, `inbox_update` | Capture-now, decide-later. Items move `raw` → `researching` → `ready` → `converted` (to a task) or `archived`. |
| **Knowledge** | `knowledge_create`, `knowledge_register_existing`, `knowledge_list`, `knowledge_get`, `knowledge_search`, `knowledge_update`, `knowledge_verify`, `knowledge_delete` | ADRs / decision logs with frontmatter. `refs[]` tracks implementation files + commit SHAs → staleness banner when code drifts. `search` is embedding-backed. |
| **Investigation** | `investigation_start`, `investigation_add_hypothesis`, `investigation_set_hypothesis_status`, `investigation_add_evidence`, `investigation_resolve`, `investigation_get` | Nonlinear debugging container (ADR-035). Hypotheses (ruled-out branches kept) + typed evidence persist across sessions; `resolve` drafts a knowledge gotcha for reuse. |
| **Code graph** | `code_ref_upsert`, `code_ref_prefix`, `code_ref_delete`, `touches_add`, `touches_remove`, `task_touches`, `graph_edges`, `feature_projection` | Couple tasks to the code they touch (`modifies` / `reference` edges) and project features from the task graph (ADR-026/032). |
| **Memory** | `memory_write`, `memory_recall`, `memory_promote_to_knowledge` | Scoped agent memory (task → workspace → project → user). Promote a load-bearing memory into a proposed ADR. |
| **Backup** | `backup_create`, `backup_list`, `backup_restore` | Daily auto-backup of the SQLite DB. Manual create + restore when you need to roll back. |
| **Ops** | `stats_report`, `cleanup_worktree_orphans`, `cleanup_artifacts` | Tool-usage telemetry (per-tool calls / error rate / dead-in-window) + worktree & artifact GC. |

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
Claude : (conversation_decide "sqlite-vec — brute KNN fine at our scale")  ← marks the thread decided
Claude : (knowledge_create ADR-020 with refs to src/embeddings/*.ts)
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

### HTTP transport

The same binary also speaks **Streamable HTTP** for remote / k8s use, selected at startup via `MCP_TRANSPORT=http` (ADR-026):

```bash
MCP_TRANSPORT=http \
MCP_HTTP_TOKEN="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")" \
  choda-deck mcp serve         # listens on :7337; POST /mcp (bearer-gated), GET /healthz
```

| Env var | Default | Purpose |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | `stdio` (local) or `http` (remote / k8s) |
| `MCP_HTTP_PORT` | `7337` | HTTP listen port |
| `MCP_HTTP_BIND` | `0.0.0.0` | Bind address (`127.0.0.1` for local-only) |
| `MCP_HTTP_TOKEN` | _required for http_ | Bearer token gating `POST /mcp` |

HTTP mode exposes a **narrowed surface** — a 6-tool read + capture allowlist (`project_list`, `task_list`, `task_context`, `inbox_list`, `inbox_get`, `inbox_add`). Everything else stays stdio-only (local trust). For `claude.ai`'s connector, swap bearer auth for Keycloak-backed OAuth with `MCP_OAUTH_MODE=1` (ADR-034). The cross-device read-only pull (`choda-deck sync pull`) drains this HTTP surface into a local SQLite copy.

### Postgres backend

Postgres backs the **HTTP transport only** (remote / k8s). It implements the narrow `RemoteOperations` port — the call graph of the HTTP allowlist above — not the full stdio surface, so `MCP_TRANSPORT=stdio` with `CHODA_BACKEND=postgres` is **rejected at boot**. Stdio is always SQLite (ADR-026 + ADR-030).

**Local dev** with the shipped `docker-compose.yml`:

```bash
docker compose up -d                             # boots pgvector/pgvector:pg16 on :5432
export CHODA_BACKEND=postgres
export CHODA_PG_URL="postgres://choda:choda@localhost:5432/choda"
MCP_TRANSPORT=http MCP_HTTP_TOKEN=dev-token choda-deck mcp serve   # schema migrates on first connect
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
