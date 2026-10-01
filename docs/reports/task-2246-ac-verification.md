---
task: TASK-2246
title: S5 tasks.assignee on both backends + assignee filter on task_list
parent: TASK-2241
verified: 2026-10-01
session: SESSION-1790843605863-60
pr: https://github.com/butterngo/choda-deck/pull/323
merge_commit: fdc6f03
result: 8/8 AC ticked
---

# TASK-2246 — AC verification

## Done (8/8)

| AC | Verdict | Evidence |
|---|---|---|
| AC-1 assignee on both schemas, parity passes | ✅ | SQLite `task-assignee.test.ts` "AC-1"; Postgres `task-assignee.pg.test.ts` "AC-1" ✓ in CI run 36837644998, ubuntu job 110288846249 (3 tests, ran) |
| AC-2 task_update 'an' → task_context 'an' | ✅ | `task-assignee.test.ts` "AC-2", via the real tool handlers on SqliteTaskService |
| AC-3 assignee null clears | ✅ | "AC-3" |
| AC-4 inbox_convert carries assignee | ✅ | "AC-4" |
| AC-5 task_list status + assignee filter | ✅ | "AC-5", against fixtures for an, binh, nobody, and a CANCELLED task of an's |
| AC-6 existing task_list tests unchanged | ✅ | `task-tools.test.ts` was not modified and passes; the compact `task_list` shape is unchanged |
| AC-7 laptop update reaches Postgres after one drain | ✅ | `task-assignee.pg.test.ts` "AC-7": write-through, then `startSyncLoop().runOnce()`, then the Postgres row |
| AC-8 Postgres filter matches SQLite | ✅ | `task-assignee.pg.test.ts` "AC-8" |

## Not done / needs a human

None.

## Findings

1. The local full suite again hit the mermaid cold-start timeouts in `mermaid-check.test.ts` and `workspace-diagram.test.ts`. Both files passed when run alone (exit 0), and CI was 192/192 green. Same flake as TASK-2242.
2. TASK-2247 (template guard) edits the same `convertInboxToTask` path. The `assignee` plumbing added here is in `InboxConvertInput` and the `tasks.create` call, not in the body handling, so the two changes should not conflict.

## Steps

Branch `feat/task-2246-assignee` → types, SQLite ALTER, Postgres migration 018, both task repositories, the lifecycle and 4 tool schemas, 2 test files → typecheck ✅ · test ✅ (flake above) · lint ✅ · build ✅ → PR #323 → CI green on 3 jobs, every pg file ran → squash-merged as fdc6f03 → `git merge-base --is-ancestor fdc6f03 origin/main` exit 0.
