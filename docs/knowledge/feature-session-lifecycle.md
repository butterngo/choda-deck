---
type: feature
title: Session lifecycle (work sessions bound to task + workspace)
projectId: choda-deck
scope: project
refs:
  - path: src/core/domain/lifecycle/session-lifecycle-service.ts
    commitSha: 0f5b7660cf547efd5ccae6461a83c30f35c23dc3
  - path: src/core/domain/repositories/session-repository.ts
    commitSha: 0f5b7660cf547efd5ccae6461a83c30f35c23dc3
  - path: src/core/domain/repositories/session-event-repository.ts
    commitSha: 0f5b7660cf547efd5ccae6461a83c30f35c23dc3
createdAt: 2026-06-04
lastVerifiedAt: 2026-06-04
realizesTasks: ["TASK-503","TASK-526","TASK-536","TASK-585","TASK-907","TASK-985"]
inWorkspaces: ["main"]
effortBand: XL
status: shipped
---

A session is the unit of activity — bound to a task and a workspace, it drives the TODO→IN-PROGRESS→DONE transition, task lock-out, handoff snapshots, checkpoints and resume. Produces a structured `session_end` summary (ADR-028) and an append-only activity log for crash recovery (ADR-029).

Spans ADR-009 / ADR-015 / ADR-028 / ADR-029 / ADR-031. TASK-986 (project_context depth=full) is a follow-up enhancement tracked separately.
