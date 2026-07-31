---
type: feature
title: Agent memory layer (scoped recall)
projectId: choda-deck
scope: project
refs:
  - path: src/core/domain/repositories/agent-memory-repository.ts
    commitSha: c0f2ccc9ff0e5170b402c5482b33ceb3f00b7ae4
  - path: src/adapters/mcp/mcp-tools/memory-recall.ts
    commitSha: c0f2ccc9ff0e5170b402c5482b33ceb3f00b7ae4
  - path: src/adapters/mcp/mcp-tools/memory-promote-to-knowledge.ts
    commitSha: c0f2ccc9ff0e5170b402c5482b33ceb3f00b7ae4
createdAt: 2026-06-04
lastVerifiedAt: 2026-07-27
anchorTaskId: TASK-790
realizesTasks: ["TASK-790","TASK-827","TASK-846","TASK-642"]
inWorkspaces: ["main"]
effortBand: L
status: shipped
---

Cross-session agent memory: write scoped memories, recall them by relevance, and promote load-bearing ones to proposed ADRs (the self-edit pipeline). Backed by `agent_memory` tables with scoped recall. ADR-023.

The static MEMORY.md auto-load is slated to be replaced by relevance-scored recall (TASK-987, the active follow-up). Anchor umbrella TASK-790.
