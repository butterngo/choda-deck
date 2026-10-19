---
type: feature
title: Agent memory layer (scoped recall)
projectId: choda-deck
scope: project
refs:
  - path: src/core/domain/repositories/agent-memory-repository.ts
    commitSha: 5ff422509137117d73fe0a9e93a7dd0f7232ff7c
  - path: src/adapters/mcp/mcp-tools/memory-recall.ts
    commitSha: 5ff422509137117d73fe0a9e93a7dd0f7232ff7c
  - path: src/adapters/mcp/mcp-tools/memory-promote-to-knowledge.ts
    commitSha: 5ff422509137117d73fe0a9e93a7dd0f7232ff7c
createdAt: 2026-06-04
lastVerifiedAt: 2026-10-19
anchorTaskId: TASK-790
realizesTasks: ["TASK-790","TASK-827","TASK-846","TASK-642"]
inWorkspaces: ["main"]
effortBand: L
status: shipped
---

Cross-session agent memory: write scoped memories, recall them by relevance, and promote load-bearing ones to proposed ADRs (the self-edit pipeline). Backed by `agent_memory` tables with scoped recall. ADR-023.

The static MEMORY.md auto-load is slated to be replaced by relevance-scored recall (TASK-987, the active follow-up). Anchor umbrella TASK-790.
