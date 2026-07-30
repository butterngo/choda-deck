---
type: feature
title: Daily SQLite backup + restore
projectId: choda-deck
scope: project
refs:
  - path: src/core/backup-service.ts
    commitSha: c0f2ccc9ff0e5170b402c5482b33ceb3f00b7ae4
  - path: src/adapters/mcp/mcp-tools/backup-tools.ts
    commitSha: c0f2ccc9ff0e5170b402c5482b33ceb3f00b7ae4
createdAt: 2026-06-04
lastVerifiedAt: 2026-07-27
realizesTasks: ["TASK-513","TASK-565","TASK-622","TASK-623"]
inWorkspaces: ["main"]
effortBand: M
status: shipped
---

A daily atomic SQLite snapshot with prune-to-7 and a restore path, exposed as MCP backup tools so a write batch can be rolled back with a single call. ADR-012.

TASK-513 carries milestone-1.
