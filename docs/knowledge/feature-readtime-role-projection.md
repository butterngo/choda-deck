---
type: feature
title: "Feature: Read-time role projection (Pillar 5)"
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-06-02
lastVerifiedAt: 2026-06-02
anchorTaskId: TASK-994
realizesTasks: ["TASK-994","TASK-995"]
inWorkspaces: ["main"]
status: shipped
---

## Description

End-user feature: a single knowledge **feature node** can be projected into three role-appropriate answers at read time, so a CEO/PO, a developer, and a tester each get only what their role needs from the same underlying graph — without a human re-summarising.

1. **CEO/PO view** — business description + apps touched + effort **band letter** (never a day count) + blocker titles. No code, no symbols.
2. **Dev view** — module + code_ref pointers (modifies/reference) + gotchas recalled *before* the first question.
3. **Tester view** — acceptance criteria collated per realized task + edge cases derived from gotcha trigger/context + regression scope (shipped tasks that must not break).

## Realizes tasks

- `TASK-994` — CEO/PO + dev read-time role projection (shared data-gathering spine; structural M3/M4 guards). Shipped, PR #163.
- `TASK-995` — tester read-time role (third role): AC collation, edge-case derivation, regression scope. Shipped, PR #164.

## In workspaces

- `main` (choda-deck) — `feature-projection.ts` (pure projection + guards), `feature-projection-builder.ts` (I/O gather), `feature-projection-tools.ts` (MCP wrapper). Single workspace, single app.

## Status

- TASK-994 **DONE** (CEO/PO + dev projection live).
- TASK-995 **DONE** (tester role live).

## Effort band

(Intentionally left blank — PILOT-2 honesty condition. This feature was authored with NO pre-written band so the projection must either derive it from realized-task evidence at read time or honestly report the gap.)

## Wire-level handoff

- `feature_projection(featureId, role)` MCP tool → role-shaped bundle + an honesty section listing what the projection used vs. lacked.
- Role is an explicit parameter; conversation-inferred role is deferred (TASK-1020).
