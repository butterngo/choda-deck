---
type: feature
title: Knowledge layer (typed entries + staleness)
projectId: choda-deck
scope: project
refs:
  - path: src/core/domain/repositories/knowledge-repository.ts
    commitSha: d69ac90d1948a597a8e0205859a3b567585d7bbb
  - path: src/core/domain/knowledge-suggestions.ts
    commitSha: d69ac90d1948a597a8e0205859a3b567585d7bbb
createdAt: 2026-06-04
lastVerifiedAt: 2026-08-24
realizesTasks: ["TASK-634","TASK-635","TASK-636","TASK-637","TASK-643","TASK-651"]
inWorkspaces: ["main"]
effortBand: L
status: shipped
---

Durable knowledge as typed entries — spike, decision, postmortem, learning, evaluation, feature, code_ref, gotcha — each with frontmatter, refs, and staleness tracking. This is where ADRs and gotchas live as first-class records the agent can list, get, search and verify. ADR-018 (+ ADR-022 workspace-scoping, ADR-025 register-existing).

TASK-990 (knowledge_list returns empty bug) and TASK-655 (cascade policy) are open follow-ups. INTEGRATES_WITH [[feature-knowledge-graph]] and [[feature-embedding-search]].
