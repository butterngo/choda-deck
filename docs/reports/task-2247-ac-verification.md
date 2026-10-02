---
task: TASK-2247
title: S6 Template guard on inbox_convert
parent: TASK-2241
verified: 2026-10-01
session: SESSION-1790844838889-1
pr: https://github.com/butterngo/choda-deck/pull/324
merge_commit: 99ec10b
result: 5/5 AC ticked
---

# TASK-2247 — AC verification

## Done (5/5)

Every criterion is SQLite-only. Each was proven by `src/adapters/mcp/mcp-tools/__tests__/inbox-template-guard.test.ts`, which drives the real `inbox_convert` / `task_create` handlers over a `SqliteTaskService`. The file passed locally and in all three CI jobs of run 36839546792.

| AC | Verdict | Evidence |
|---|---|---|
| AC-1 missing ## Test Plan refused by name, no task, draft unchanged | ✅ | test "AC-1" |
| AC-2 no checkbox under ## Acceptance refused | ✅ | test "AC-2" |
| AC-3 blank `- [ ]` placeholder refused | ✅ | test "AC-3" (covers both `- [ ]` and `- [ ] `) |
| AC-4 conforming body converts | ✅ | test "AC-4" (discriminator for AC-1..3) |
| AC-5 task_create without a body unchanged | ✅ | test "AC-5" |

## Not done / needs a human

None.

## Findings

1. **Decision beyond the written AC.** A conversion with **no body** is now refused too, because the resulting task would have no template. That is Butter's stated goal ("every task follows the template"), but the AC did not spell it out. The existing lifecycle tests that converted without a body (7 call sites in `inbox-lifecycle-service.test.ts`) now pass a template body; their intent (status, rollback, localization warning) is unchanged.
2. The guard lives in `InboxLifecycleService.convertInboxToTask`, the single path every conversion takes (MCP tool and `SqliteTaskService`). It runs inside the transaction **before** `tasks.create`, so a refusal writes nothing.
3. The refusal is a `LifecycleError`, so `tryLifecycle` returns it as a text reply. That matches the existing convention for inbox errors (e.g. "no projectId"); it is not an MCP `isError` result.
4. The local full suite hit the documented mermaid cold-start timeout once more (`workspace-diagram.test.ts`, which passes when run alone). CI was green.

## Steps

1. Branch `feat/task-2247-template-guard`.
2. Changes: `task-template.ts`, `InboxTemplateError`, the lifecycle call, 7 test call sites updated, and the new test file.
3. Local gates: typecheck ✅ · test ✅ (flake above) · lint ✅ · build ✅.
4. PR #324 → CI green ×3 → squash-merged as 99ec10b.
5. Merge verified: `git merge-base --is-ancestor 99ec10b origin/main` exits 0.

The previous attempt at this task was halted before `session_start` when the choda-tasks MCP disconnected; the empty branch was deleted then. This run started fresh after `/mcp` reconnected.
