---
task: TASK-2245
title: S4 Attribution — inbox created_by, token-derived conversation author, remote INBOX-R-NNN ids
parent: TASK-2241
verified: 2026-10-01
session: SESSION-1790843046719-47
pr: https://github.com/butterngo/choda-deck/pull/322
merge_commit: 7ca5936
result: 9/9 AC ticked
---

# TASK-2245 — AC verification

## Done (9/9)

The Postgres-backed criteria come from `src/adapters/mcp/__tests__/attribution.pg.test.ts`. In **CI run 36836469455, ubuntu job 110284975209** it shows `✓ (6 tests) 10836ms`, meaning it ran rather than being skipped. All 13 `.pg.test.ts` files in that job show ✓ and none show ↓.

| AC | Verdict | Evidence |
|---|---|---|
| AC-1 created_by on both schemas, parity passes | ✅ | SQLite: `inbox-created-by.test.ts` "AC-1". Postgres: attribution.pg "AC-1". `sync-columns.test.ts` green |
| AC-2 remote inbox_add attributes to the token | ✅ | attribution.pg "AC-7 + AC-2": the client also sent `created_by: 'butter'`, and the stored value is `'an'` |
| AC-3 pull carries created_by to SQLite | ✅ | attribution.pg "AC-3 + AC-8": real `pull()` from `fetchSinceFromPg` |
| AC-4 conversation_open records the member | ✅ | attribution.pg "AC-4" |
| AC-5 conversation_add records the member | ✅ | attribution.pg "AC-5" |
| AC-6 converter keeps the client name | ✅ | attribution.pg "AC-6", which is the discriminator for AC-5 |
| AC-7 fresh remote mints INBOX-R-001/002 | ✅ | attribution.pg "AC-7 + AC-2". The updated `postgres-task-service.pg.test.ts` is also ✓ |
| AC-8 laptop's next id is previous + 1 after the pull | ✅ | attribution.pg "AC-3 + AC-8" |
| AC-9 pulling INBOX-R-005 leaves the counter alone | ✅ | `inbox-created-by.test.ts` "AC-9", run locally through the real `pull()` path |

## Not done / needs a human

None.

## Findings

1. **Intended format change.** `postgres-task-service.pg.test.ts` expected the remote to mint `INBOX-001` and was updated to `INBOX-R-001`. Existing remote rows keep their old `INBOX-NNN` ids; only new remote captures use the `INBOX-R-` prefix.
2. **Two Keycloak usernames can collide with stdio names.** `attributedName()` overrides the name only for a non-converter caller, so a converter can still post as `claude`, which is intended. A member whose Keycloak username equals another participant's display name (for example a member called `butter`) would be indistinguishable in the thread. The runbook in TASK-2248 should tell the admin to choose member usernames that do not clash.
3. All pg files ran in this CI job. The silent-skip harness flake (TASK-2252) did not recur here.

## Steps

Branch `feat/task-2245-attribution`. Changes: types, SQLite ALTER, Postgres migration 017, both inbox repositories, the `inbox-remote` counter, `attributedName` / `callerMemberOrNull`, the inbox and conversation tools, and 2 new tests plus 1 updated test. Gates: typecheck ✅ · full suite ✅ · lint ✅ · build ✅. Opened PR #322; CI was green on all 3 jobs and every pg file ran. Squash-merged as 7ca5936. Merge proof: `git merge-base --is-ancestor 7ca5936 origin/main` returned exit 0.
