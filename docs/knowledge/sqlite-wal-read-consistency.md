---
type: learning
title: "SQLite WAL read consistency — why CLI may briefly see stale state"
projectId: choda-deck
scope: project
refs:
  - path: src/core/domain/sqlite-task-service.ts
    commitSha: 7372151645a685e19ec7772703c7d16673cb77fa
  - path: src/core/domain/repositories/schema.ts
    commitSha: 7372151645a685e19ec7772703c7d16673cb77fa
  - path: src/adapters/cli/service-factory.ts
    commitSha: 7372151645a685e19ec7772703c7d16673cb77fa
  - path: src/adapters/cli/index.ts
    commitSha: 7372151645a685e19ec7772703c7d16673cb77fa
  - path: README.md
    commitSha: 7372151645a685e19ec7772703c7d16673cb77fa
createdAt: 2026-05-07
lastVerifiedAt: 2026-05-07
---

# SQLite WAL read consistency — why CLI may briefly see stale state

> AI-Context: choda-deck opens its SQLite store in WAL mode (write-ahead log) so the MCP server and the CLI can read the same DB concurrently without blocking each other. WAL is great for shared reads but it does not give CLI readers an instant view of in-flight MCP writes — a CLI read started while a transaction is still open returns a snapshot from the last checkpoint, not the unwritten frames in the log. The lag is normally sub-second and self-heals after the next commit; for users this manifests as "I just asked Claude to update X, then ran `choda-deck task list` and don't see it yet — re-run after 1-2s". This entry documents why that happens and the recommendation we ship to users.

## Origin

Created as the AC4 follow-up to TASK-669 (`choda-deck CLI v1 — verifiable read-only commands`). Decision in CONV-1778123840455-1: CLI reads SQLite directly to bypass MCP middleman + token cost. The trade-off — that direct reads can momentarily lag the MCP-side writes — was accepted explicitly, with `--fresh` flag deferred to phase 1.1 if real users report pain.

## What WAL mode does

When a `better-sqlite3` connection runs `PRAGMA journal_mode = WAL`, SQLite stops using the rollback journal and instead appends new pages to a separate `<db>-wal` file. Two consequences matter for choda-deck:

1. **Concurrent readers don't block writers, and a writer doesn't block readers.** Both processes hold their own connection; the WAL file mediates.
2. **A reader sees a consistent snapshot at the moment its transaction begins.** New frames appended by an in-progress writer are invisible to the reader until that writer commits and a checkpoint folds the WAL pages back into the main DB file (or the reader starts a fresh transaction past the commit boundary).

In choda-deck the writer is always the MCP server (`mcp serve`), and readers are everyone else: the CLI, ad-hoc `sqlite3` shells, backup tooling, future tooling.

## Where it manifests

The visible symptom is a CLI command returning state that's slightly behind what Claude (via MCP) just wrote. Concrete examples:

- Claude calls `task_update` to flip a task's status. Butter immediately runs `choda-deck task list` from a different terminal and sees the old status.
- Claude calls `inbox_archive` on INBOX-076. Butter runs `choda-deck inbox list --project choda-deck` within ~500ms and the item still shows `researching`.
- A long-running MCP transaction (e.g. lifecycle service holding a tx open across multiple statements) keeps a writer lock for tens of milliseconds; CLI reads during that window see pre-transaction state.

The lag in practice is typically under one second on a local SSD with a healthy WAL. It is **not** a correctness bug — it is a snapshot-isolation guarantee.

## Recommendation

The CLI ships with these expectations:

- **Re-run after 1-2 seconds** if the output looks stale. Subsequent reads start a new transaction past the writer's commit point and see the up-to-date state.
- **For scripting** (`--json` piped into automation), assume eventual consistency on the order of a second. If a script must wait for a specific write, it should poll for the expected condition rather than read once and assume the latest write is visible.
- **When the MCP server is not running** (e.g. CLI used to debug a broken MCP), readers see whatever is already committed — there is no "phantom write" risk because no writer is active.

Phase 1 of the CLI explicitly defers a `--fresh` flag (which would issue `PRAGMA wal_checkpoint(FULL)` before reading) on the basis that the lag is small and predictable. If real users hit recurring pain, revisit in phase 1.1 with one of:

- `--fresh` flag — checkpoint then read; correct but adds a fsync per call.
- "wait then read" helper — sleep N ms, then read; simpler but coarse.
- WAL `synchronous = NORMAL` review — already the default, does not affect read freshness.

## Why we accept the trade-off

Two concrete alternatives were considered and rejected:

1. **Make the CLI talk to the MCP server over IPC.** Rejected because it defeats the primary purpose of the CLI — a verifiable read path that works even when MCP is down or buggy. CLI dies with MCP.
2. **Run the CLI without WAL (rollback journal).** Rejected because the CLI would block whenever the MCP held a writer lock, and vice versa. Worse UX than seeing slightly stale state.

WAL with documented eventual consistency is the lowest-friction path: CLI is independent of MCP liveness, and the rare cross-process race is bounded and self-healing.

## What to verify if this entry goes stale

If `knowledge_verify` flags this entry, check that the following invariants still hold in code:

- `sqlite-task-service.ts` opens the DB and explicitly sets `journal_mode = WAL` (currently line 141). If that pragma changes, this entry's premise changes — rewrite the recommendation accordingly.
- `service-factory.ts` for the CLI uses the same `SqliteTaskService` constructor path — if a different connection profile is introduced, document its consistency model here.
- README's "Reading freshness" section and the CLI root `--help` text both link to this slug. If either changes, update the cross-reference.

## Related

- TASK-669 — choda-deck CLI v1 (this entry's parent context)
- CONV-1778123840455-1 — decision to ship direct DB reads with WAL
- ADR-018 — knowledge layer foundation (frontmatter + ref staleness)
