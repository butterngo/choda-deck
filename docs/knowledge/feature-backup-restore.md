---
type: feature
title: Daily SQLite backup + restore
projectId: choda-deck
scope: project
refs:
  - path: src/core/backup-service.ts
    commitSha: 3f1de6130d7a67b9d7d31df63bf37a4c6346d010
  - path: src/adapters/mcp/mcp-tools/backup-tools.ts
    commitSha: 3f1de6130d7a67b9d7d31df63bf37a4c6346d010
createdAt: 2026-06-04
lastVerifiedAt: 2026-10-05
realizesTasks: ["TASK-513","TASK-565","TASK-622","TASK-623"]
inWorkspaces: ["main"]
effortBand: M
status: shipped
---

A daily atomic SQLite snapshot with prune-to-7 and a restore path, exposed as MCP backup tools so a write batch can be rolled back with a single call. ADR-012.

TASK-513 carries milestone-1.
