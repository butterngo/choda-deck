---
task: TASK-2244
title: S3 Scope every remote MCP tool to the caller's projects
parent: TASK-2241
verified: 2026-10-01
session: SESSION-1790842149202-34
pr: https://github.com/butterngo/choda-deck/pull/321
merge_commit: 11379f4
result: 9/9 AC ticked
---

# TASK-2244 — AC verification

## Done (9/9)

All pg-backed criteria were proven by `src/adapters/mcp/__tests__/remote-scope.pg.test.ts` in **CI run 36835364934, ubuntu job 110282106409**, where the file shows `✓ (9 tests) 14049ms` against real Postgres on head 2a93ff6. The fixture has projects P1 and P2, member `an` in P1 only, and a converter token.

| AC | Verdict | Evidence |
|---|---|---|
| AC-1 project_list → P1 only | ✅ | test "AC-1" |
| AC-2 list tools without projectId → no P2 ids | ✅ | test "AC-2" |
| AC-3 list tools with projectId P2 → [] | ✅ | test "AC-3", with a P1 control |
| AC-4 foreign get = unknown-id reply | ✅ | test "AC-4" — see the note below |
| AC-5 writes into P2 refused, counts unchanged | ✅ | test "AC-5", plus a discriminator: the P1 write lands |
| AC-6 inbox_add with no project refused | ✅ | test "AC-6" (missing and empty string) |
| AC-7 conversation_add on a P2 thread = unknown-id reply, no message | ✅ | test "AC-7" (corrected in 2a93ff6, see Findings 1) |
| AC-8 converter path unchanged | ✅ | 188/188 files green; test "AC-8" (converter sees P1 + P2) |
| AC-9 allowlist coverage guard | ✅ | `remote-scope.test.ts` locally: an injected unscoped name is returned and the guard throws naming it; the same guard runs at HTTP boot |

**AC-4 note.** The tools' not-found reply echoes the requested id (`Task TASK-P2 not found` vs `Task TASK-NOPE not found`). The test compares the two replies after replacing the echoed id with a placeholder. There is no other difference, so the reply reveals nothing about whether a foreign id exists.

## Not done / needs a human

None.

## Findings

1. **First CI run: AC-7 assertion wrong, not the code.** `conversation_add` reports an unknown id as a `LifecycleError` text reply (tryLifecycle), not an `isError` result. The test had asserted `isError: true`, which the unknown-id path never sets. Fixed in 2a93ff6 to assert what AC-7 says: same reply as the unknown id, and no message appended. The production code did not change between the two runs.
2. **The Postgres harness silently skipped this file once on Linux CI.** In job 110281360255 (green), `remote-scope.pg.test.ts` showed `↓ 9 skipped` while the other 11 `.pg.test.ts` files ran. Docker detection runs per worker with a 5 s timeout (`src/test/postgres-harness.ts:56-73`). That run was not used as evidence; the job was rerun (110282106409) and the file executed. Filed as **TASK-2252**: a green ubuntu job does not by itself prove every pg test ran.
3. Local full suite: the first run hit the vitest "Worker exited unexpectedly" pool error (0 failed tests, one file's results lost); the rerun was clean, exit 0.

## Steps

Branch `feat/task-2244-tool-scoping` → `remote-scope.ts` + bootstrap wiring + `PostgresTaskService.listProjectsForMember` + 2 test files → typecheck ✅ · test ✅ (rerun) · lint ✅ · build ✅ → PR #321 → CI red on AC-7 assertion → test fix 2a93ff6 → CI green but pg file skipped → job rerun → pg file ✓ → squash-merged 11379f4 → `git merge-base --is-ancestor 11379f4 origin/main` exit 0.
