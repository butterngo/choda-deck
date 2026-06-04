# Architecture — Choda Deck

## Overview

Choda Deck is a **pure Node MCP server** — no UI, no Electron, no PTY, no renderer. It is a
SQLite-backed task / session / conversation / inbox / knowledge orchestration layer exposed to
Claude Code over the Model Context Protocol. One TypeScript binary serves two transports (stdio for
local Claude Code, HTTP for remote / k8s) and two storage backends (SQLite locally, an optional
narrowed Postgres facade for the remote surface).

Architecture style: **single-source-of-truth datastore + thin MCP adapter**. SQLite
(`better-sqlite3`, direct file access — never an in-memory copy) is the only authoritative state;
the MCP layer is a stateless translation of tool calls into repository operations. The unit of work
is a **task**; the unit of activity is a **session** bound to a task + workspace.

> **Historical note.** Earlier revisions of this document described an Electron desktop app
> (main/preload/renderer processes, `node-pty` + `xterm.js`, `pty:*` IPC) and a Neo4j graph layer
> (`vault-parser`, `neo4j-import`, `Neo4jGraphService`). **All of that is gone** — `src/main/`,
> `src/preload/`, `src/renderer/`, `src/graph/`, `electron.vite.config.ts`, and `scripts/spike-pty.mjs`
> no longer exist. The graph now lives inside SQLite (see [Knowledge-graph model](#knowledge-graph-model)).

## Layers / Components

| Component | Role |
| --- | --- |
| `src/adapters/mcp/server-bootstrap.ts` | Entry point. `startMcpServer()` resolves data paths + backend, builds the service, selects transport via `MCP_TRANSPORT`. Defines `REMOTE_TOOL_ALLOWLIST`. |
| `src/adapters/mcp/server.ts` | Deprecated alias kept for backward-compatible imports. |
| `src/adapters/mcp/instrumented-server.ts` | Tool-registration facade. Wraps the MCP server with telemetry and enforces the per-transport tool allowlist. |
| `src/adapters/mcp/http-transport.ts` | Streamable HTTP transport (stateless). Routes `/mcp`, `/healthz`, and the OAuth endpoints. |
| `src/adapters/mcp/oauth/` | OAuth 2.0 DCR endpoints (`discovery.ts`, `register.ts`, `authorize.ts`, `token.ts`, `pkce.ts`, `consent-template.ts`) — see ADR-027. |
| `src/adapters/mcp/mcp-tools/` | Per-domain MCP tool handlers (project, task, session, inbox, conversation, knowledge, code-ref, graph, memory, backup, cleanup, stats). |
| `src/core/domain/task-service-factory.ts` | Single construction point. Picks the backend (`CHODA_BACKEND` = `sqlite` \| `postgres`) and composes it. |
| `src/core/domain/sqlite-task-service.ts` | The SQLite facade (top god-node). Implements the full `TaskService` interface by composing every per-domain repository. |
| `src/core/domain/postgres-task-service.ts` | Narrow Postgres facade. Implements **only** `RemoteOperations` — the strict subset the HTTP allowlist needs (ADR-030). |
| `src/core/domain/remote-operations.interface.ts` | The narrow port that bounds the HTTP/Postgres surface. |
| `src/core/domain/repositories/` | One repository per table family (see [Data model](#data-model)). `schema.ts` holds the DDL (`initSchema`, `SCHEMA_VERSION`). |
| `src/core/domain/lifecycle/` | Transactional lifecycle services (session, conversation, inbox, AC-check) — ADR-015. |
| `src/core/domain/task-types.ts` | Pure type definitions, zero runtime deps — incl. the `RelationType` graph-edge enum. |
| `src/core/paths.ts` | `resolveDataPaths()` / `resolveBackendConfig()` — single source for DB / artifacts / backups paths and backend selection. |
| `src/core/backup-service.ts` | Daily SQLite snapshot + prune + restore (ADR-012). |

## Transports

The server supports two transports from one binary, selected at startup via `MCP_TRANSPORT`
(default `stdio`). See **ADR-026** for the full rationale; operational env vars are tabulated in
`CLAUDE.md` (§MCP Transport Modes).

### Stdio (default — local Claude Code)

`StdioServerTransport` over stdin/stdout. **Full tool surface** — local trust contract, every
domain tool registered. This is what `.claude.json` registrations use against the bundled
`dist/mcp-server.cjs`.

### HTTP (remote / k8s)

Streamable HTTP transport in **stateless** mode, bound to `MCP_HTTP_BIND:MCP_HTTP_PORT`
(default `0.0.0.0:7337`).

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `POST /mcp` | Bearer or OAuth | Tool invocations (JSON, 4 MB body cap) |
| `GET /healthz` | none | k8s liveness/readiness — `{"ok":true}` |
| `/.well-known/*`, `/register`, `/authorize`, `/token` | none | OAuth 2.0 DCR flow (ADR-027), active only when `MCP_OAUTH_MODE=1` |

**Narrowed surface.** HTTP exposes only the **6-tool read + capture allowlist**
(`REMOTE_TOOL_ALLOWLIST` in `server-bootstrap.ts`): `project_list`, `task_list`, `task_context`,
`inbox_list`, `inbox_get`, `inbox_add`. Non-allowlisted tools are not registered at all — they never
appear in `tools/list` and return `-32602 Tool not found` if called by name. Auth is a static bearer
(`MCP_HTTP_TOKEN`) by default, or OAuth 2.0 against the `oauth_*` tables when `MCP_OAUTH_MODE=1`.

## Backend split (ADR-030)

| | Stdio | HTTP |
| --- | --- | --- |
| Backend | SQLite (`SqliteTaskService`) | SQLite **or** Postgres (`PostgresTaskService`) |
| Surface | Full `TaskService` | Narrow `RemoteOperations` only |
| Trust | Local | Network-exposed |

`MCP_TRANSPORT=stdio` + `CHODA_BACKEND=postgres` is **rejected at boot** (`requireBackendForTransport`):
the narrow PG facade is missing every stdio-only method, so the pairing would fail at first tool call.

**Standing rule** — the PG surface = the remote allowlist's call graph + OAuth. Expanding the allowlist
requires three coordinated edits in one PR: (1) add the tool to `REMOTE_TOOL_ALLOWLIST`, (2) add the
methods it calls to `RemoteOperations`, (3) implement them on `PostgresTaskService` + any missing
repos/migrations.

## Data model

SQLite is the single source of truth. DDL lives in `src/core/domain/repositories/schema.ts`
(`initSchema`, `SCHEMA_VERSION`), applied on MCP-server boot. Standalone migration scripts that open
the DB directly must self-apply their DDL — `initSchema` does not run from uncommitted `src/`.

Each table family has a dedicated repository under `src/core/domain/repositories/`; the
`SqliteTaskService` facade composes them (SRP — one repository owns one table family).

| Repository | Owns |
| --- | --- |
| `task-repository.ts` | Tasks — CRUD, dependencies, body content |
| `inbox-repository.ts` | Inbox items — raw idea → triage pipeline |
| `knowledge-repository.ts` | Knowledge entries (spike / decision / postmortem / learning / evaluation / feature / code_ref / gotcha) + refs |
| `session-repository.ts` | Work sessions — lifecycle, handoff snapshots, checkpoints |
| `session-event-repository.ts` | Append-only session activity log (crash recovery) |
| `conversation-repository.ts` | Conversations — participants, messages, decisions, read-tracking |
| `workspace-repository.ts` | Workspaces — project scope + cwd binding, soft-delete |
| `project-repository.ts` | Projects |
| `agent-memory-repository.ts` | Agent memories — scoped recall (ADR-023) |
| `relationship-repository.ts` | Knowledge-graph edges (generic `relationships` table) |
| `code-ref-repository.ts` | Code anchors + `task_code_refs` (TOUCHES) edges |
| `document-repository.ts` | Documents (adr / guide / spec / note / research) |
| `tag-repository.ts` | Tags |
| `context-source-repository.ts` | Files/dirs to preload into a project's sessions |
| `counter-repository.ts` | Global ID counters (TASK-NNN, INBOX-NNN — single-writer safe) |

OAuth state (`oauth_clients`, `oauth_access_tokens`, `oauth_refresh_tokens`) and embedding storage
(vector index, ADR-020) also live in the same DB.

## Knowledge-graph model

The graph is **not** a separate store — it is two SQLite tables plus a query tool. This is the
subject of the still-PROPOSED **ADR-NNN (unified knowledge graph)**, whose §6 open questions are
being frozen by **TASK-999** before it gets a real number; treat the code as the source of truth
until then.

### Generic edges — `relationships` table

A single `(from_id, to_id, type)` table with **no `type` CHECK constraint** — adding a future edge
type needs only a widening of the `RelationType` enum in `task-types.ts`, no DB migration. Current
edge types (`task-types.ts:10-19`):

- **Original task/tech edges:** `DEPENDS_ON`, `IMPLEMENTS`, `USES_TECH`, `DECIDED_BY`
- **First-class graph edges (TASK-992):** `REALIZES` (task → feature), `ABOUT` (knowledge/gotcha → feature), `PINS` (task/feature → knowledge), `IN` (feature/gotcha → workspace), `INTEGRATES_WITH` (feature ↔ feature)

### Attributed edges — `task_code_refs` table (TOUCHES, TASK-988)

TOUCHES carries an attribute, so it lives in its own table rather than `relationships`:
`(task_id, code_ref_slug, relation)` where `relation ∈ {modifies, reference}` — `modifies` = the task
edits the anchor, `reference` = it reads it as a pattern. Code anchors (file + symbol + workspace
identity, git-pinned) are owned by `code-ref-repository.ts`.

### Query surface — `graph_edges`

The `graph_edges` MCP tool (`src/adapters/mcp/mcp-tools/graph-tools.ts`) reads
`RelationshipRepository` and returns `{ fromId, toId, type }` edges for a node, filterable by `type`
and `direction` (`out` / `in` / `both`). **Stdio-only** — not in the HTTP allowlist.

## Lifecycle services (ADR-015)

Transactional coordinators in `src/core/domain/lifecycle/`, composed by the MCP tools — they own
multi-step state transitions so individual tool handlers stay thin.

| Service | Drives |
| --- | --- |
| `session-lifecycle-service.ts` | Session start / end / checkpoint / resume; task lock-out, workspace binding, status `TODO→IN-PROGRESS→DONE/CANCELLED`. Structured `session_end` summary (ADR-028). |
| `conversation-lifecycle-service.ts` | Conversation open / decide / signoff; participant consensus, decision summaries. |
| `inbox-lifecycle-service.ts` | Inbox triage `raw → researching → ready → converted`; links items to task IDs, auto-closes linked conversations. |
| `ac-check.ts` | Acceptance-criteria checkbox flips — pure helpers (`flipAcCheckbox`, `findAcItem`), composed inside transactions (ADR-029 narrow bypass). |

## Backup + data layout (ADR-012)

`backup-service.ts` runs a daily atomic SQLite snapshot (`shouldRunDailyBackup` → `runBackup`),
pruning to the 7 newest (`pruneOld`). Paths come from `resolveDataPaths()` under `CHODA_DATA_DIR`:

```
data/
├── database/choda-deck.db
├── artifacts/<sessionId>/
└── backups/choda-deck-<date>.db
```

`CHODA_DB_PATH` is still accepted as a legacy override (logs a warning).

## God-nodes (most-connected abstractions)

The system's most-connected abstractions are: `SqliteTaskService` (the facade, by far the highest
degree), `KnowledgeService`, `ConversationRepository`, `PostgresTaskService` (narrowed),
`TaskRepository`, `CodeRefRepository`, and `initSchema`. These are the highest-blast-radius
components — change them deliberately. (The graphify code-graph that previously cross-checked this
list was retired in ADR-033; the `code_ref` / `TOUCHES` layer is the current coupling source.)

## ADR cross-reference

This document summarises; the ADRs in `docs/knowledge/` decide. Do not duplicate their content here.

| ADR | Topic |
| --- | --- |
| ADR-012 | Daily backup + restore |
| ADR-015 | Lifecycle-service pattern |
| ADR-018 | Knowledge layer (entry types, frontmatter, staleness) |
| ADR-020 | Embedding architecture (sqlite-vec) |
| ADR-023 | Agent-memory layer |
| ADR-026 | Dual-transport MCP server (stdio + HTTP, per-tool scoping) |
| ADR-027 | Self-hosted OAuth 2.0 DCR for the claude.ai connector |
| ADR-028 | Structured `session_end` summary |
| ADR-029 | Session activity visibility |
| ADR-030 | Dual-backend split (SQLite + narrow Postgres) |
| ADR-NNN | Unified knowledge graph — PROPOSED, frozen by TASK-999 |
