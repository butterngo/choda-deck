---
type: feature
title: Knowledge graph (edges + TOUCHES + feature projection)
projectId: choda-deck
scope: project
refs:
  - path: src/core/domain/repositories/relationship-repository.ts
    commitSha: 0f5b7660cf547efd5ccae6461a83c30f35c23dc3
  - path: src/core/domain/repositories/code-ref-repository.ts
    commitSha: 0f5b7660cf547efd5ccae6461a83c30f35c23dc3
  - path: src/adapters/mcp/mcp-tools/graph-tools.ts
    commitSha: 0f5b7660cf547efd5ccae6461a83c30f35c23dc3
createdAt: 2026-06-04
lastVerifiedAt: 2026-06-04
realizesTasks: ["TASK-988","TASK-992","TASK-993","TASK-998","TASK-999"]
inWorkspaces: ["main"]
effortBand: L
status: in-progress
---

The graph is not a separate store — it is two SQLite tables plus a query tool. A generic `relationships` table carries REALIZES/ABOUT/PINS/IN/INTEGRATES_WITH edges; an attributed `task_code_refs` table carries TOUCHES (modifies/reference) against git-pinned code anchors. `graph_edges` is the stdio-only read surface. Subject of the still-PROPOSED unified-knowledge-graph ADR (ADR-032), being frozen by TASK-999.

This is the engine the feature-discover skill itself writes into. INTEGRATES_WITH [[feature-readtime-role-projection]].
