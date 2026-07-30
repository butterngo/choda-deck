---
type: feature
title: Autonomous queue runner + auto-safe harness (partially deprecated)
projectId: choda-deck
scope: project
refs:
  - path: src/core/executor/coder.ts
    commitSha: c0f2ccc9ff0e5170b402c5482b33ceb3f00b7ae4
  - path: src/core/executor/tester.ts
    commitSha: c0f2ccc9ff0e5170b402c5482b33ceb3f00b7ae4
  - path: src/core/executor/ac-report.ts
    commitSha: c0f2ccc9ff0e5170b402c5482b33ceb3f00b7ae4
  - path: src/core/executor/prewarm-compose.ts
    commitSha: c0f2ccc9ff0e5170b402c5482b33ceb3f00b7ae4
createdAt: 2026-06-04
lastVerifiedAt: 2026-07-27
anchorTaskId: TASK-826
realizesTasks: ["TASK-698","TASK-699","TASK-728","TASK-826","TASK-982"]
inWorkspaces: ["main"]
effortBand: XL
status: shipped
---

A headless executor that picks safe tasks off a queue, runs a coder→tester→AC-report loop in an isolated worktree, gated by an auto-safe validator and prewarm/spawn strategy. ADR-019 (queue runner) + ADR-023 (auto-safe v2 hardening) + ADR-024 (review status + checkpoint).

**Partially deprecated:** TASK-982 removed the queue runner; the executor primitives (coder/tester/AC-report/prewarm) remain. TASK-1031 proposes pruning dead code-graph MCP tools. Anchor TASK-826 is the review-lifecycle umbrella.
