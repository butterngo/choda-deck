---
type: decision
title: "ADR-030: Dual-backend storage (SQLite local + Postgres remote) with pending-ops sync"
projectId: choda-deck
scope: project
refs:
  - path: src/core/domain/sqlite-task-service.ts
    commitSha: 255f371b3340903687577a34bcf1e25432aa7532
  - path: src/core/paths.ts
    commitSha: 255f371b3340903687577a34bcf1e25432aa7532
  - path: src/core/sync/canonical-json.ts
    commitSha: 255f371b3340903687577a34bcf1e25432aa7532
  - path: src/core/sync/export-service.ts
    commitSha: 255f371b3340903687577a34bcf1e25432aa7532
  - path: src/core/sync/import-service.ts
    commitSha: 255f371b3340903687577a34bcf1e25432aa7532
  - path: src/adapters/mcp/server-bootstrap.ts
    commitSha: 255f371b3340903687577a34bcf1e25432aa7532
createdAt: 2026-05-22
lastVerifiedAt: 2026-05-25
---

> **AI-Context:** Two storage backends behind one driver port. Local MCP (stdio) drives SQLite; remote MCP (http, k8s) drives Postgres. The laptop syncs to remote via a **pending-ops queue + LWW reconciliation** built on top of the existing `src/core/sync/` snapshot machinery. Remote Postgres is **canonical when reachable**; local SQLite is a working copy that can write offline and drain on reconnect. Op-log-per-tool-call is rejected — the existing export/import + a small pending queue covers single-user multi-device without it.

## Status (2026-05-25)

| Component | State | Where it landed |
|---|---|---|
| Backend service port (`BackendTaskService`) | **Done** | TASK-933 + TASK-934 slice 11 (facade) |
| Postgres adapter (`PostgresTaskService`) — all 24 service methods | **Done** | TASK-934 slices 1–20b (PRs #131–#152) |
| pgvector embedding store + slug-keyed `EmbeddingStorePort` | **Done** | TASK-934 slice 14 + 20b |
| Factory wiring via `CHODA_BACKEND` env | **Done** | TASK-934 slice 11 |
| One-shot SQLite → Postgres data migration script | **Done** | TASK-934 slice 21 (`scripts/migrate-sqlite-to-postgres.mjs`) |
| docker-compose + README k8s recipe | **Done** | TASK-934 slice 21 |
| **Sync engine — `pending_ops` queue, Lamport clocks, LWW reconcile, `sync_conflicts` table, `CHODA_BACKEND=sync` mode** | **Open** | not started |

The driver/adapter half of this ADR shipped; the cross-device sync half did not. Today the deployment model is **one backend per process** — pick `sqlite` for local stdio, `postgres` for remote HTTP, no automatic drain between them. Same machine can absolutely run both with separate data, but a single logical "my tasks" view that follows you across devices via offline-tolerant sync is still future work. Use the existing manual export/import (`src/core/sync/`, [[cross-device-sync-export-import-spec]]) when you need to round-trip between devices.

Revisit the sync engine when: (a) the claude.ai remote connector becomes day-to-day and a second device starts writing concurrently, OR (b) a concrete data-loss incident from manual export/import makes the case for automatic drain.

## Context

- Today both transports ([[ADR-026-dual-transport-mcp-server]]) hit the same `better-sqlite3` file. Multi-replica was explicitly deferred to [[INBOX-366]].
- `src/core/sync/` already implements snapshot export → git → snapshot import for **SQLite↔SQLite cross-device** ([[cross-device-sync-export-import-spec]], 2026-05-07). Canonical JSON shape, atomic apply, tombstones, manifest versioning — all already in code.
- Goal: extend the data layer so the **remote MCP HTTP server** writes to Postgres, while local MCP keeps SQLite — without rewriting the existing sync.
- Use case is single-user multi-device (laptop + claude.ai connector + future phone). Not multi-tenant. Not many writers. Conflict surface is rare-but-real (laptop edits offline, claude.ai connector edits same task remotely).

Research surveyed in [[CONV-1779449079722-1]]: ElectricSQL (rough 2026 edges), PowerSync (forces JSON-shape schema + sidecar service), Turso Sync (libSQL-only, no Postgres), Litestream (one-way DR, not bidirectional). None fit the "single-user multi-device + Postgres-required" shape better than building above the existing sync code.

## Decision

Two coupled changes:

**1. Backend abstraction (driver port).** Introduce `DatabaseDriver` async interface. Implementations: `SqliteDriver` (wraps `better-sqlite3` in `Promise.resolve`), `PostgresDriver` (uses `pg`). All services (`task-service`, `inbox-service`, `session-service`, …) move behind the port. `sqlite-task-service.ts` becomes `task-service.ts` (driver-agnostic).

**2. Sync mechanism (pending-ops + LWW).** Local SQLite gains a `pending_ops` table — append-only mutations queued when remote is unreachable. On reconnect, drain to remote with row-level LWW on `updated_at` (Lamport-logical, not wall-clock). Pull deltas back via the existing canonical-JSON snapshot pipeline, parameterized to accept Postgres as a source.

### Backend resolution

| Env | Backend | Sync |
|---|---|---|
| `CHODA_BACKEND=sqlite` (default for stdio) | SQLite | off |
| `CHODA_BACKEND=postgres` (default for http) | Postgres | off |
| `CHODA_BACKEND=sync` | SQLite + pending-ops queue | on — drains to remote MCP |

Auto-default tied to `MCP_TRANSPORT` (stdio→sqlite, http→postgres); explicit `CHODA_BACKEND` always wins. `PG_DSN` required when backend resolves to `postgres`.

### Schema additions (every syncable table)

- `id TEXT` — ULID (sortable UUID). Replaces INTEGER autoincrement. Migration: assign ULIDs, keep old PK as `legacy_id` (retained indefinitely for diagnostic + foreign-key bridging).
- `updated_at INTEGER` — Lamport-logical timestamp (monotonic counter persisted in `_sync_clock`), NOT wall-clock.
- `deleted_at INTEGER NULL` — tombstone, retention window 30 days (configurable via `CHODA_TOMBSTONE_TTL_DAYS`).
- `origin TEXT` — device that wrote this row (`laptop`, `remote`). Diagnostic only; not used in conflict resolution beyond tie-break.

### `pending_ops` (local SQLite only)

```sql
CREATE TABLE pending_ops (
  seq INTEGER PRIMARY KEY,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  op TEXT NOT NULL,         -- 'upsert' | 'delete'
  payload TEXT NOT NULL,    -- canonical-JSON row
  lamport INTEGER NOT NULL,
  enqueued_at INTEGER NOT NULL
);
CREATE INDEX idx_pending_ops_seq ON pending_ops(seq);
```

### Conflict rule

LWW per row on `(updated_at, origin)` — higher Lamport wins; tie-break by `origin` lexicographic (`laptop` < `remote`). Same-field concurrent edit on a tasks DB used by one human is rare enough that LWW is fine; full CRDT rejected per research conversation.

Conflicts that drop a queued op are logged to a local `sync_conflicts` table AND emitted as `inbox_add` items (raw status) so Butter sees them in the next `/daily`. Silent data loss is unacceptable; visible loss is.

### Write semantics

**Synchronous write-through on the tool call** — when laptop is online (`CHODA_BACKEND=sync`), every mutating tool call writes to local SQLite *and* the remote MCP, both completing before returning to Claude. Failure modes:

- Local write fails → tool call fails. Standard error path.
- Local write succeeds, remote fails (timeout / 5xx / network) → op enqueued to `pending_ops`, tool call returns success. The remote write becomes the queue's responsibility.

Rationale: consistency > latency. Async fire-and-forget would let Claude see "success" then have the write silently dropped if the queue drain later finds a conflict. Sync-then-enqueue keeps the success contract honest.

## How it works

```mermaid
flowchart TB
  subgraph Laptop["Laptop (offline-capable)"]
    CC[Claude Code<br/>stdio client]
    LMCP[MCP Server<br/>CHODA_BACKEND=sync]
    SQLite[(SQLite<br/>working copy)]
    Queue[(pending_ops<br/>queue)]
    CC -->|tool call| LMCP
    LMCP -->|read/write| SQLite
    LMCP -.->|enqueue on remote-fail<br/>or offline| Queue
  end

  subgraph K8s["Remote (k8s)"]
    RMCP[MCP Server<br/>CHODA_BACKEND=postgres]
    PG[(Postgres<br/>canonical)]
    RMCP -->|read/write| PG
  end

  subgraph ClaudeAI["claude.ai connector"]
    Web[Web / Mobile]
    Web -->|OAuth / MCP| RMCP
  end

  LMCP -->|HTTP write-through<br/>when online| RMCP
  Queue -.->|drain on reconnect<br/>LWW reconcile| RMCP
  RMCP -.->|pull deltas<br/>since last_pull_at| LMCP

  classDef canonical fill:#1e3a5f,stroke:#4a9eff,color:#fff
  classDef cache fill:#3d2a1e,stroke:#d97706,color:#fff
  class PG canonical
  class SQLite,Queue cache
```

**Lifecycle of a write — laptop (`CHODA_BACKEND=sync`):**

1. Claude Code calls e.g. `task_update`.
2. Service writes to local SQLite — sub-millisecond. Increments Lamport clock.
3. Service writes to remote MCP over HTTP (using OAuth from [[ADR-027]] or bearer from ADR-026).
   - **Success** → mark row `last_synced_at = now`. Return to Claude.
   - **Failure** (network / 5xx / timeout < 2s) → append op to `pending_ops`. Return to Claude. No error surfaced.

**Lifecycle of a write — remote (`CHODA_BACKEND=postgres`):**

1. claude.ai connector calls e.g. `task_update` via OAuth-gated HTTP.
2. Service increments Lamport clock + writes to Postgres in one transaction. Done.
3. No queue, no sync — Postgres is canonical.

**Reconnect drain — laptop (periodic + on-startup):**

1. Connectivity check (HEAD `/healthz`). Skip cycle if down.
2. For each row in `pending_ops` ordered by `seq`:
   - POST to remote MCP tool with the queued payload + `lamport`.
   - Remote applies LWW: if remote's `updated_at > op.lamport` → remote wins, op dropped, conflict logged to `sync_conflicts` + an `inbox_add` raw item.
   - Op succeeds → delete from `pending_ops`.
3. After drain, **pull** deltas: GET remote snapshot since `last_pull_at`, upsert into SQLite with LWW.

**Pull — laptop:**

1. Request: `since = last_pull_at`.
2. Remote returns all rows where `updated_at > since` OR `deleted_at > since`, in canonical-JSON shape (existing format from `canonical-json.ts`).
3. For each: if `local.updated_at >= remote.updated_at` → keep local. Else upsert (or apply tombstone).
4. Bump `last_pull_at` to max remote timestamp seen.

### Why pending-ops beats a full op-log

The existing `src/core/sync/` already speaks **snapshot of canonical-JSON rows**, not events. Adding `pending_ops` is ~150 lines on top; building a full event-sourced op-log replayer is ~2000 lines and re-implements what snapshot already does. Lamport timestamps + tombstones give LWW correctness without modeling every tool call as an event. Op-log is the right answer in isolation; in the context of the existing code, snapshot+queue wins.

## Options considered

| Option | Pro | Con |
|---|---|---|
| A. Status quo (single SQLite, both transports) | Zero change | Postgres-shaped problems (concurrency, scale) unresolved |
| B. Both transports → Postgres | Single backend, no sync needed | Loses offline-local, loses zero-config dev, k8s dep for `pnpm dev` |
| C. PowerSync as the sync engine | Battle-tested, ~1 week to wire | Forces JSON-shape schema (single-table + views), adds a sidecar service, single-user multi-device pays the multi-tenant tax |
| D. **Driver port + pending-ops + reuse existing snapshot** | Builds on shipped sync code, no new deps beyond `pg`+`ulid`, LWW correctness, MIT in-process | We own conflict logic forever; sync→async refactor touches every service |
| E. Full op-log / event sourcing | Audit log free, pure correctness | Re-implements snapshot infrastructure we already have; 4-6 weeks |
| F. Turso Sync (libSQL ↔ libSQL) | Single-binary sync | Postgres not supported → moves the goal posts |
| G. ElectricSQL | Active-active, MIT | 2026 production evaluators hit rough edges around shapes + reconnection |

## Why not others

- **C (PowerSync)**: schema rewrite + sidecar service is real cost; single-user use case doesn't earn back the multi-tenant features. Reconsider if a second human user ever joins.
- **E (op-log)**: rejected after finding `src/core/sync/` already exists. Op-log would supersede working code — wrong direction.
- **F (Turso)**: incompatible with the "remote = Postgres" requirement.
- **G (ElectricSQL)**: rough edges reported by production teams in early 2026; depending on shape-management bugs is the wrong bet for a personal-deploy use case where we don't have the bandwidth to chase upstream fixes.

## Consequences

- **Good:** Local stays zero-config (SQLite). Remote gets concurrency story (Postgres). Existing sync code is leveraged, not rewritten. Pending-ops queue is invisible to Claude — no error UX when offline. No new external service to deploy alongside the MCP HTTP server. Conflicts that LWW would silently drop become visible as inbox items.
- **Bad:** Service layer goes sync→async (every call site touched). Schema migration to ULIDs is non-trivial. We own LWW conflict logic; subtle bugs possible. Test matrix doubles — every service needs SQLite + Postgres coverage.
- **Risks:**
  - **Same-task concurrent edit** (laptop offline + claude.ai connector online) → LWW silently overwrites the loser. Mitigation: `sync_conflicts` table + `inbox_add` surfacing.
  - **Tombstone retention** — too short loses delete propagation, too long bloats the table. Default 30 days, configurable.
  - **Postgres pod restart drops in-flight drain** — drain is idempotent (Lamport guard), retry-safe.
  - **Schema drift between SQLite and Postgres** — two SQL files maintained in parallel. Mitigation: schema-parity test that introspects both at startup and fails CI on drift.
  - **Clock skew under partition** — Lamport clocks are causally consistent on a single device but two offline devices editing the same row can produce ties. Tie-break by `origin` is deterministic but arbitrary; that's the surfaced-conflict case.

## Impact

- **Files/modules to change:**
  - NEW: `src/core/data/database-driver.ts` (port), `sqlite-driver.ts`, `postgres-driver.ts`
  - NEW: `src/core/sync/pending-ops.ts`, `sync-reconcile.ts`, `lamport-clock.ts`
  - NEW: `src/core/sync/sync_conflicts` table + inbox emission hook
  - Refactor: all `*-service.ts` files behind driver port (sync → async). **Scoped as a prerequisite task** — land the refactor with no behavior change before any Postgres or sync code.
  - Extend: `src/core/sync/export-service.ts`, `import-service.ts` to accept either driver
  - Migration: assign ULIDs + add `updated_at`/`deleted_at`/`origin` columns. Idempotent script runnable on both backends.
  - `src/core/paths.ts`: backend-aware (Postgres has no `database/` file path; `PG_DSN` resolved instead).
  - `src/core/backup-service.ts`: branch on driver — file copy vs `pg_dump`.
  - `CLAUDE.md`: env var table addition (`CHODA_BACKEND`, `PG_DSN`, `CHODA_TOMBSTONE_TTL_DAYS`).
- **Dependencies added:** `pg` (~600 KB), `ulid` (~5 KB). No ORM in v1 — raw SQL kept for both backends.
- **Migration needed:** Yes. One-shot script: mint ULIDs, backfill `updated_at` from existing `created_at`/`updated_at` where available else `now()`, add columns, populate `origin='laptop'` for existing rows. Runs idempotently. Postgres schema bootstrapped from same migration source.

## Revisit when

- Second human user joins → conflict surface grows, may need CRDT for shared-edit tables (probably `conversation_messages` first).
- `pending_ops` regularly >10k entries → batch drain + payload compression.
- Postgres adoption stable + laptop offline use rare → consider deprecating the SQLite remote-write path entirely (laptop always proxies, no local persistence).
- `pg_dump` backup pain → switch to managed Postgres snapshot.
- LWW silently loses an edit Butter actually wanted despite the inbox surfacing → add per-field merge for `conversation_messages` (append-only CRDT-lite).
- Schema drift bugs recur → adopt Drizzle/Kysely for a single schema source of truth.

## Related

- Builds on: [[ADR-026-dual-transport-mcp-server]] — this ADR fills the deferred Postgres slot
- Builds on: [[cross-device-sync-export-import-spec]] — existing snapshot/canonical-JSON code is the foundation
- Supersedes: [[INBOX-366]] — subsumed into this ADR's Postgres scope
- Closes: [[INBOX-375]] — this research item
- Touches: [[ADR-012-sqlite-backup-restore]] — needs `pg_dump` branch
- Touches: [[ADR-027-oauth-mcp-server]] — write-through uses same auth path
- Researched in: [[CONV-1779449079722-1]]
