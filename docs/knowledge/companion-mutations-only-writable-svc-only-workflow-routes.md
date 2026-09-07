---
type: gotcha
title: Companion adapter mutations go only through the writable service, only via workflow.ts routes
projectId: choda-deck
scope: project
refs:
  - path: src/adapters/companion/workflow.ts
    commitSha: 11114d72e186e4eb7e43a408ff4aeba43a5a4681
  - path: src/adapters/companion/http-server.ts
    commitSha: 11114d72e186e4eb7e43a408ff4aeba43a5a4681
  - path: src/adapters/companion/service-factory.ts
    commitSha: 11114d72e186e4eb7e43a408ff4aeba43a5a4681
createdAt: 2026-07-15
lastVerifiedAt: 2026-07-15
affectedFeatureId: feature-companion-cockpit
---

## Trigger

Adding any companion HTTP route that mutates tasks, sessions, or inbox — or being tempted to run a write through the adapter's `services.db` handle.

## Context

The companion adapter (TASK-1158) was read-only by design; TASK-1171 added the first mutating routes (mark READY, session start/end) for the Workflow Cockpit. The service factory exposes two data paths: `services.svc` (writable `BackendTaskService`) and `services.db` (a readonly better-sqlite3 connection reserved for raw sync-column scans — ledger/health/log).

## Business rule

Reads stay on their existing paths (readonly `db` for raw sync scans, `svc` reads for typed lists). Mutations go ONLY through the writable `BackendTaskService`, and ONLY via the routes in `workflow.ts` (plus the pre-existing `/sync/pull|push` and `/capture`). Never widen the readonly handle to write; never scatter mutating routes into `http-server.ts`'s switch; zero `src/adapters/mcp` edits (isolation is the contract — see [[companion-adapter-must-add-zero-mcp-edits]]).

## Resolution

New mutations: add a handler in `workflow.ts` (it returns `handled: boolean` so http-server stays a 2-line wire-up), guard it idempotent-safe with honest 400s, and cover it in `workflow.test.ts` with a round-trip integration test. Established in TASK-1171 (#204, 06bd5e3).
