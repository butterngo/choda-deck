---
type: feature
title: Task management core (the unit of work)
projectId: choda-deck
scope: project
refs:
  - path: src/core/domain/sqlite-task-service.ts
    commitSha: 0f5b7660cf547efd5ccae6461a83c30f35c23dc3
  - path: src/core/domain/repositories/task-repository.ts
    commitSha: 0f5b7660cf547efd5ccae6461a83c30f35c23dc3
  - path: src/core/domain/repositories/counter-repository.ts
    commitSha: 0f5b7660cf547efd5ccae6461a83c30f35c23dc3
createdAt: 2026-06-04
lastVerifiedAt: 2026-06-04
realizesTasks: ["TASK-405","TASK-502","TASK-503","TASK-583","TASK-624"]
inWorkspaces: ["main"]
effortBand: XL
status: shipped
---

The foundational layer: a task is the unit of work, stored in SQLite as the single source of truth. Covers task CRUD, dependencies, body/acceptance-criteria content, and the global ID counter (TASK-NNN). This is what the pivot to a pure MCP server (TASK-624) was built around — every other feature hangs off the task record.

God-node: `SqliteTaskService` is by far the highest-degree abstraction (architecture.md §God-nodes). High blast radius — change deliberately.
