---
type: decision
title: "ADR-035: Investigation domain object — first-class nonlinear debugging container, pattern capture via the knowledge layer"
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-06-09
lastVerifiedAt: 2026-06-09
---

# ADR-035: Investigation domain object — first-class nonlinear debugging container, pattern capture via the knowledge layer

> AI-Context: Adds a fourth domain primitive alongside Task / Session / Conversation — the `investigation`: a durable, cross-session container for **nonlinear** debugging state (symptom → hypotheses[testing|ruled_out|confirmed] → typed evidence → root_cause/fix). It exists because the Task lifecycle is linear and Session state is ephemeral, so mid-trace state (especially *ruled-out* branches) is held only in conversation context and lost on compaction. Three new SQLite tables, a `InvestigationLifecycleService` (ADR-015), and a stdio-only MCP tool surface (NOT in `REMOTE_TOOL_ALLOWLIST`, ADR-026). Pattern capture does **not** get its own store — `investigation_resolve` emits a human-gated `knowledge_create(type='gotcha')` draft, reusing the knowledge layer (feature-knowledge-layer, ADR-031). Implements TASK-603.

## Context

Debugging is **nonlinear exploration** — branch, backtrack, dead-end — but every existing primitive models something else:

- **Task** is linear: `TODO → IN-PROGRESS → DONE`. It has no place for "I tested hypothesis X and ruled it out", and its board would be polluted by non-deliverable trace nodes.
- **Session** is ephemeral: it opens, does work, and closes. Its `session_checkpoint` (ADR-024) snapshots a *resume point*, not a structured hypothesis/evidence graph, and the state dies with the session.
- **Conversation** is for multi-party review, not single-actor trace state.

The motivating case (remote-workflow, 2026-04-23): Claude traced "Test button broken" through four layers. The full trail — hypotheses, evidence, dead ends — lived in working memory. When context compressed mid-session, the mid-investigation state was lost and several ruled-out hypotheses had to be re-examined. Three concrete failures fall out of having no home for this state:

1. **Context bloat** — the whole trace sits in working memory; long sessions compress and lose it.
2. **No store for ruled-out hypotheses** — they must be re-derived in the same or a later session.
3. **Root-cause patterns aren't captured** — after the fix, the reusable pattern evaporates.

This ADR rules on **whether `investigation` is a new first-class object or a remodel of an existing primitive, how it is stored, how composite ops stay atomic, where it is exposed, and how pattern capture is handled.** It is the ADR-before-build gate on TASK-603.

## Constraints (load-bearing)

1. **Composite, multi-table ops must be atomic (ADR-015).** `investigation_resolve` touches the investigation row, possibly a confirming hypothesis, and produces a knowledge draft. Per ADR-015 this is an `InvestigationLifecycleService` wrapping `db.transaction(...)` — same pattern as Inbox (TASK-530), same sync better-sqlite3 constraint (no `await` inside the txn).
2. **The knowledge layer already does pattern capture-and-recall.** `knowledge_create(type='gotcha')` + `knowledge_search` + the `harvest-knowledge` skill already store and resurface reusable root-cause patterns (feature-knowledge-layer, ADR-031). A second "pattern library" would duplicate this. TASK-603's scope decision (confirmed 2026-06-09) is to **reuse** it.
3. **Knowledge writes are human-gated (ADR-031 / harvest-knowledge precedent).** Auto-writing a gotcha on every resolve would bloat the knowledge layer with low-signal entries. Resolve emits a *draft*, the human commits it — mirroring the `memoryCandidate` rail.
4. **HTTP surface is a narrow read+capture allowlist (ADR-026).** Investigation is a local debugging aid with no remote consumer; adding it to `REMOTE_TOOL_ALLOWLIST` would also require widening `RemoteOperations` + the Postgres facade (the three-edit standing rule). It stays **stdio-only**.

## Options considered

| Option | Pro | Con |
|---|---|---|
| A. Model on **Task** (hypotheses = subtasks, evidence = body text) | No new tables; reuses board/AC machinery | Linear status enum can't express `ruled_out`; pollutes the task board with non-deliverable nodes; evidence-as-prose isn't queryable; conflates "work to do" with "trace state" |
| B. Model on **Session / checkpoint** only | Reuses session binding; no new object | Ephemeral — state dies at `session_end`; checkpoint is a resume-point string, not a hypothesis/evidence graph; a trace spanning sessions loses ruled-out branches (the exact failure) |
| C. Status quo — **conversation-context convention** | Zero build | Lost on compaction — this *is* the problem being solved |
| **D. New first-class `investigation` object (this ADR)** | Models nonlinear state natively; persists ruled-out branches across sessions; queryable typed evidence; clean separation from linear task work | New tables + lifecycle service + tool surface; a fourth primitive to maintain |
| D-sub. Pattern capture: separate store vs **reuse knowledge layer** | Reuse: no duplication, inherits search + staleness + harvest flow | A dedicated pattern table would re-implement gotcha capture that already ships |

## Decision

**Chosen: Option D — a new first-class `investigation` domain object, with pattern capture reusing the knowledge layer (D-sub: reuse).**

### Data model (3 tables, same SQLite DB — ADR-004)

```
investigation
  id            TEXT PK        -- INVESTIGATION-<seq> (id convention per existing primitives)
  symptom       TEXT NOT NULL
  status        TEXT NOT NULL  -- exploring | confirmed | resolved
  task_id       TEXT NULL      -- optional soft binding (FK task.id), standalone allowed
  session_id    TEXT NULL      -- optional soft binding (FK session.id)
  root_cause    TEXT NULL      -- filled at resolve
  fix_summary   TEXT NULL      -- filled at resolve
  pattern_tag   TEXT NULL      -- seeds the knowledge draft on resolve
  created_at    TEXT NOT NULL
  resolved_at   TEXT NULL

hypothesis
  id              TEXT PK
  investigation_id TEXT NOT NULL FK
  description     TEXT NOT NULL
  status          TEXT NOT NULL  -- testing | ruled_out | confirmed
  created_at      TEXT NOT NULL

evidence
  id              TEXT PK
  investigation_id TEXT NOT NULL FK
  hypothesis_id   TEXT NULL FK     -- evidence may attach to the investigation or a specific hypothesis
  type            TEXT NOT NULL    -- screenshot | log | network | code_snippet
  ref             TEXT NOT NULL    -- path / url / locator
  note            TEXT NULL
  created_at      TEXT NOT NULL
```

**Ruled-out hypotheses are never deleted** — they are status-flipped to `ruled_out` and returned on read. Persisting the dead ends is the whole point (Constraint-derived from failure #2).

### Binding to Task / Session is optional (soft, nullable)

`task_id` / `session_id` are nullable foreign keys. An investigation may be started standalone (a quick trace with no task), or bound to the task/session it arose under. This mirrors ADR-009's stance that sessions are bound but investigations are a lighter, more transient artifact — forcing a task binding would recreate the board-pollution problem of Option A.

### Composite ops via the Lifecycle Service Pattern (ADR-015)

`InvestigationLifecycleService` owns the multi-row transitions. `resolve` is the one genuinely composite op: it sets `status='resolved'` + `resolved_at`, persists `root_cause`/`fix_summary`/`pattern_tag`, and **returns** a knowledge-draft payload — all reads/writes to SQLite inside one sync txn; the knowledge draft is *returned to the handler*, not written in the same transaction (it is human-gated, see below).

### Pattern capture reuses the knowledge layer (no parallel store)

On `investigation_resolve`, the service composes a `knowledge_create(type='gotcha')` **draft** from `pattern_tag` + `symptom` + `root_cause` + `fix_summary` and returns it as a candidate — exactly the `memoryCandidate` shape ADR-031 / harvest-knowledge already use. The human commits it via the existing `knowledge_create` flow. No `investigation_pattern` table, no second search index: future "have I seen this symptom?" lookups go through `knowledge_search` over gotchas, which already exists.

### Transport scope: stdio-only (ADR-026)

The tool surface — `investigation_start`, `investigation_add_hypothesis`, `investigation_set_hypothesis_status`, `investigation_add_evidence`, `investigation_resolve`, `investigation_get` — is registered **stdio-only**. It is **not** added to `REMOTE_TOOL_ALLOWLIST`; no `RemoteOperations` / Postgres facade work is in scope.

### Error contract

Lifecycle mutations validate state and fail atomically: resolve on an already-`resolved` investigation, evidence/hypothesis ops against an unknown id, or an illegal hypothesis transition return a clear MCP error with **no partial write** (one txn, rolled back on throw — ADR-015 guarantee).

## Consequences

**Positive**
- Nonlinear trace state — including ruled-out branches — survives context compaction and spans sessions.
- Typed, queryable evidence replaces prose-buried screenshots/logs.
- Pattern capture inherits the knowledge layer's search, staleness, and human-gated harvest flow for free — zero new recall machinery.
- Clean separation: the task board stays a list of deliverables, not a debugging scratchpad.

**Negative / accepted tradeoffs**
- A fourth domain primitive to maintain (schema, lifecycle service, tools, tests).
- Soft (nullable) task/session binding means investigations can orphan — accepted; they are cheap and a future `cleanup_*` pass can archive resolved+old ones.
- `pattern_tag` quality depends on the AI choosing a good tag at resolve time (same human-gated quality bar as gotcha drafts).

**Defers / rejects**
- **Rejects** a dedicated pattern-library store (D-sub) — the knowledge layer covers it.
- **Defers** the investigation-flavored `session_checkpoint` variant (`current_layer` / `ruled_out[]` / `suspect` / `next_step`) — listed in TASK-603 as a follow-up; revisit once the base object ships and mid-trace checkpointing proves needed.
- **Defers** debug-skill auto-wiring (the `/debug` skill auto-opening an investigation) — a separate task; this ADR ships only the primitive + tools.
- **Defers** remote/HTTP exposure — only if a remote debugging consumer ever appears (would trigger the ADR-026 three-edit rule).

## Revisit when

- Mid-trace crash-resume proves necessary → reopen the checkpoint variant.
- Investigations accumulate enough that `knowledge_search` over gotchas underperforms a structured pattern index → reconsider D-sub.
- A remote client needs read access to investigations → ADR-026 allowlist widening.

## Implementation roadmap (TASK-603)

| Order | Work | AC |
|---|---|---|
| 1 | This ADR | (gate) |
| 2 | Schema: `investigation` / `hypothesis` / `evidence` tables + migration | AC-1..3 |
| 3 | `InvestigationLifecycleService` (ADR-015) — start / add_hypothesis / set_hypothesis_status / add_evidence | AC-1, AC-2, AC-3 |
| 4 | `investigation_resolve` — atomic resolve + returned `knowledge_create(gotcha)` draft | AC-4 |
| 5 | `investigation_get` — full nested read (hypotheses incl. ruled_out + evidence) | AC-5 |
| 6 | Negative-path errors (resolve-twice, unknown id, illegal transition) — no partial write | AC-6 |
| 7 | Register stdio-only MCP tools (NOT in REMOTE_TOOL_ALLOWLIST) + vitest unit/integration | AC-7 |

## Related

- [[ADR-015-lifecycle-service-pattern]] — composite atomic ops contract the resolve path uses
- [[ADR-009-session-lifecycle]] — optional session binding + the bound-vs-transient distinction
- [[ADR-004-sqlite-task-management]] — single-DB storage substrate
- [[ADR-026-dual-transport-mcp-server]] — stdio-only scoping + the remote-allowlist three-edit rule
- [[ADR-031-session-end-derivation]] — the human-gated `memoryCandidate` draft precedent reused at resolve
- [[feature-knowledge-layer]] — the gotcha store + `knowledge_search` that pattern capture reuses
- TASK-603 — implementation of this ADR

---

**Status: ACCEPTED — ADR-035.** Implemented + merged via PR #181 (squash 0a2c3b0); TASK-603 DONE. Registered in the knowledge index.
