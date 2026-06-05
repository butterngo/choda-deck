---
type: feature
title: Inbox triage pipeline (raw idea → converted task)
projectId: choda-deck
scope: project
refs:
  - path: src/core/domain/repositories/inbox-repository.ts
    commitSha: 0f5b7660cf547efd5ccae6461a83c30f35c23dc3
  - path: src/core/domain/lifecycle/inbox-lifecycle-service.ts
    commitSha: 0f5b7660cf547efd5ccae6461a83c30f35c23dc3
  - path: src/core/domain/inbox-triage-policy.ts
    commitSha: 0f5b7660cf547efd5ccae6461a83c30f35c23dc3
createdAt: 2026-06-04
lastVerifiedAt: 2026-06-04
realizesTasks: ["TASK-511","TASK-754","TASK-777","TASK-819","TASK-993"]
inWorkspaces: ["main"]
effortBand: L
status: shipped
---

A capture-first pipeline that takes a raw idea and walks it through researching → ready → converted, linking the result to a task ID and auto-closing any linked conversation. The triage policy is pure/heuristic and composed inside a transactional lifecycle service. ADR-011.
