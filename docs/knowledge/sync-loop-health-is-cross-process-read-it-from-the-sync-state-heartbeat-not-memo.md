---
type: gotcha
title: Sync-loop health is cross-process — read it from the _sync_state heartbeat, not memory
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-06-20
lastVerifiedAt: 2026-06-20
affectedFeatureId: feature-companion-cockpit
---

**Trigger:** needing `loopAlive` / `lastPullAgeSec` / `jwtState` (or any drain-loop state) from a process that isn't the one running the loop.

**Context:** the `CHODA_BACKEND=sync` drain/pull loop (`startSyncLoop`) runs inside the **stdio MCP server process**. Other processes — e.g. the companion REST adapter — share only the SQLite file, not the loop's in-memory state.

**Business rule:** loop liveness cannot be read in-memory across processes. It must be observable from the shared DB.

**Resolution:** the loop stamps a **wall-clock** heartbeat into the singleton `_sync_state` row each cycle (additive columns via `src/core/sync/sync-loop-status.ts`: `loop_last_run_at`, `loop_last_pull_at`, `loop_reachable`, `loop_jwt_state`). Readers derive `loopAlive = heartbeat age < 2× interval`, and report loop-down honestly when no/stale heartbeat — never stale-but-ok. Rejected alternatives: running a second loop in the reader (double-drain), or inferring liveness from the pull cursor (a guess, no jwtState).
