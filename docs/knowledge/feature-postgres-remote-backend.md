---
type: feature
title: Narrow Postgres backend for the remote surface
projectId: choda-deck
scope: project
refs:
  - path: src/core/domain/postgres-task-service.ts
    commitSha: 0f5b7660cf547efd5ccae6461a83c30f35c23dc3
  - path: src/core/domain/remote-operations.interface.ts
    commitSha: 0f5b7660cf547efd5ccae6461a83c30f35c23dc3
createdAt: 2026-06-04
lastVerifiedAt: 2026-06-04
realizesTasks: ["TASK-925","TASK-933","TASK-934"]
inWorkspaces: ["main"]
effortBand: M
status: in-progress
---

A deliberately narrow Postgres facade that implements only `RemoteOperations` — the strict subset the HTTP allowlist needs — so the network-exposed surface can run on Postgres while local stdio stays on SQLite. ADR-030.

Standing rule: expanding the allowlist means three coordinated edits (allowlist + `RemoteOperations` + `PostgresTaskService`) in one PR. The write-through/LWW sync half is parked under [[feature-cross-device-sync]]; this feature is the read-only narrow facade.
