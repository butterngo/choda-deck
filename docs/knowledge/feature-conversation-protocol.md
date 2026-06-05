---
type: feature
title: Conversation protocol + review cycle
projectId: choda-deck
scope: project
refs:
  - path: src/core/domain/lifecycle/conversation-lifecycle-service.ts
    commitSha: 0f5b7660cf547efd5ccae6461a83c30f35c23dc3
  - path: src/core/domain/repositories/conversation-repository.ts
    commitSha: 0f5b7660cf547efd5ccae6461a83c30f35c23dc3
createdAt: 2026-06-04
lastVerifiedAt: 2026-06-04
anchorTaskId: TASK-972
realizesTasks: ["TASK-504","TASK-533","TASK-535","TASK-609","TASK-753","TASK-920","TASK-972"]
inWorkspaces: ["main"]
effortBand: XL
status: shipped
---

Structured conversations between agents/humans: participants, messages, binding decisions, read-tracking, and a VERDICT/TOP-CONCERN/ASKS review turn shape. The conversation schema refactor (TASK-972, 4 phases) is the defining epic; TASK-920's structured reviewer schema was later removed (TASK-972) and the discipline now lives by convention. ADR-010.

TASK-1035 (stale CLAUDE.md doc documenting the removed TASK-920 schema) is open cleanup, not part of the feature body.
