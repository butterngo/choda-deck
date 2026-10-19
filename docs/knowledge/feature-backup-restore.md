---
type: feature
title: Daily SQLite backup + restore
projectId: choda-deck
scope: project
refs:
  - path: src/core/backup-service.ts
    commitSha: 5ff422509137117d73fe0a9e93a7dd0f7232ff7c
  - path: src/adapters/mcp/mcp-tools/backup-tools.ts
    commitSha: 5ff422509137117d73fe0a9e93a7dd0f7232ff7c
createdAt: 2026-06-04
lastVerifiedAt: 2026-10-19
realizesTasks: ["TASK-513","TASK-565","TASK-622","TASK-623"]
inWorkspaces: ["main"]
effortBand: M
status: shipped
---

A daily atomic SQLite snapshot with prune-to-7 and a restore path, exposed as MCP backup tools so a write batch can be rolled back with a single call. ADR-012.

TASK-513 carries milestone-1.
