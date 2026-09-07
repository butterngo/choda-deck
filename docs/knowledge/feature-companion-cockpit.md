---
type: feature
title: Choda Companion — glass cockpit over the laptop (sync + workflow + knowledge)
projectId: choda-deck
scope: project
refs:
  - path: src/adapters/companion/http-server.ts
    commitSha: 74bb36750b2f80f2b0fd6772a40c2e4774a9489f
  - path: src/adapters/companion/sync-ledger.ts
    commitSha: 74bb36750b2f80f2b0fd6772a40c2e4774a9489f
  - path: src/adapters/companion/sync-health.ts
    commitSha: 74bb36750b2f80f2b0fd6772a40c2e4774a9489f
  - path: src/adapters/companion/sync-actions.ts
    commitSha: 74bb36750b2f80f2b0fd6772a40c2e4774a9489f
  - path: src/core/sync/sync-loop-status.ts
    commitSha: 74bb36750b2f80f2b0fd6772a40c2e4774a9489f
createdAt: 2026-06-20
lastVerifiedAt: 2026-07-13
anchorTaskId: TASK-1157
realizesTasks: ["TASK-1157","TASK-1158","TASK-1159","TASK-1160","TASK-1175","TASK-1214","TASK-1215","TASK-1216","TASK-1171","TASK-1172","TASK-1173","TASK-1174"]
inWorkspaces: ["main","choda-deck-companion"]
effortBand: XL
status: in-progress
---

A web UI that makes the invisible visible: **sync state** (what is and isn't synced two ways between laptop and remote) and **workflow state** (what am I doing / done / next), rendered over the choda-deck knowledgebase. "Everything is in doubt" is an observability gap, not a data gap — sync has been two-way for tasks/inbox/conversations/projects since TASK-979 + TASK-1130; the *lens* was missing.

> **Reconstructed 2026-07-12.** The original file was lost — the `knowledge_index` row survived (with its `REALIZES` and `ABOUT` edges intact) but the `.md` never landed in git on any branch. Rebuilt from anchor epic TASK-1157, its sub-tasks, and the six gotchas carrying `affectedFeatureId: feature-companion-cockpit`. Grounded in those sources only — no invented history. The prose here is a reconstruction, not the original wording.

## The load-bearing constraint

The web app addresses **exactly one API — the laptop**, via a local REST adapter. It never calls the remote pod (`mcp.choda.dev`) and never holds an OAuth credential. The laptop's own sync engine (ADR-030 / ADR-034) owns laptop↔remote; the companion only *renders the laptop's view of both sides*, using columns that already exist on every synced row: `sync_origin` (laptop|remote), `sync_updated_at`, the pull cursor, and tombstones. This is what makes "laptop = single source of truth" real, and keeps JWT complexity out of the browser.

## Three pillars

1. **Sync Observatory** (pillar 1 — substantially shipped) — a per-entity ledger: ✓in-sync / ⬆local-only / ⬇remote-only / ⚠tombstoned, plus drain-loop and JWT-refresh health, plus manual Pull/Push. A chronological sync activity feed is landing on top of it.
2. **Workflow Cockpit** (pillar 2 — open) — a browser rendering of `/choda-task-focus`: NOW / NEXT / DONE + inbox triage + light actions (mark READY, start/end session).
3. **Knowledgebase** (pillar 3 — open) — browse ADRs/features, per-ref staleness, and the task↔ADR↔conversation graph.

## Architecture

The server side is `src/adapters/companion/` in the **choda-deck** repo — a sibling adapter to `cli/` and `mcp/`, a thin layer over `src/core` services, bound to `127.0.0.1` only. The web client is a separate Vite/React app in the **choda-deck-companion** repo. Precedent for the shape: `http-transport.ts` already serves non-MCP routes (`/sync/since`, `/sync/apply`) beside `/mcp` — extra HTTP over shared core is the established pattern.

Reads go through a read-only connection; the mutating routes (`POST /sync/pull`, `POST /sync/push`, and the pillar-2 workflow actions) use the writable service. That read/write split is deliberate — keep it explicit.

## Invariants

Each of these has its own gotcha entry pointing back here via `affectedFeatureId`:

- **Zero MCP edits.** The adapter must never touch `mcp-tools/`, `REMOTE_TOOL_ALLOWLIST`, `RemoteOperations`, `PostgresTaskService`, or the `/mcp` transport. Isolation *is* the contract — [[companion-adapter-must-add-zero-mcp-edits]].
- **Exactly one API base.** All web data access goes through `API_BASE = '/api'`; a `single-api.test.ts` guard fails the build if a remote pod URL appears in web source — [[companion-web-must-address-exactly-one-api-base-never-the-remote-pod]].
- **Honest liveness.** Screens must visibly distinguish connected / stale / disconnected, and never render old data as fresh — [[companion-screens-must-render-honest-liveness-never-fake-live]].
- **Write actions confirm, then surface the real outcome.** No silent no-ops, no fake success; a 404 from a missing endpoint must read as an error — [[companion-write-actions-must-confirm-surface-result-or-error-never-silent]].
- **Loop health is cross-process.** `loopAlive` / `lastPullAgeSec` / `jwtState` must be read from the `_sync_state` heartbeat, not from memory — the drain loop runs inside the stdio MCP process, not the adapter — [[sync-loop-health-is-cross-process-read-it-from-the-sync-state-heartbeat-not-memo]].
- **Ledger bucket precedence is fixed:** tombstoned > remote-only > in-sync > local-only, encoded as ordered `CASE` branches (never independent COUNTs) — [[sync-ledger-bucket-precedence-is-fixed-tombstoned-remote-only-in-sync-local-only]].
- **Design tokens** come from the pre-reset commit `5a3a14d`, not `docs/handoff-design/` (wiped in the companion repo reset) — [[companion-web-design-tokens-come-from-pre-reset-5a3a14d-not-docs-handoff-design-]].

## Status

Pillar 1: adapter (TASK-1158), web shell with degraded-state handling (TASK-1159), Observatory screen (TASK-1160) and Pull/Push endpoints (TASK-1175) are all landed. The sync activity log is mid-flight — TASK-1214 (`sync_events` table) implemented, TASK-1215 (`GET /sync/log`) in progress, TASK-1216 (feed UI) ready.

Pillars 2 and 3 (TASK-1171 → TASK-1174) are still TODO.

## Related

- [[feature-cross-device-sync]] · [[ADR-030-dual-backend-sync]] · [[ADR-034-keycloak-backed-http-auth-via-on-origin-proxy]]
- [[feature-companion-ui]] — the earlier read-mostly companion (Queue / Tasks / Conversations / Inbox over the HTTP transport). Its `views/` were intentionally dropped in the repo reset as the wrong requirement; this cockpit replaces that scope with the sync / workflow / knowledge pillars.
