# TASK-2312 — AC verification

**Task:** Count only PR merges in the activity digest and flag stale merged sessions
**Commit:** `cbfb7a0` on `feat/task-2312-pr-only-merge-count` (not pushed)
**Session:** SESSION-1791896629192-61, 2026-10-13

## Done (4/4)

| # | Criterion | Evidence |
|---|---|---|
| 1 | Fixture with 1 merge commit, 1 `(#N)` squash, 1 `jm-ci` and 1 direct push → merges 2, directPushes 1; fails on the old code | `activity-runner.test.ts` "TASK-2312 AC-1" returns `{ merges: 2, directPushes: 1, skipped: 0 }`. Against HEAD's runner the same test fails with `expected { merges: 4, skipped: 0 }` |
| 2 | Digest JSON carries `metrics.directPushes` as a number | Built `dist/cli.cjs activity digest --date 2026-10-05` on a copy of the live DB: `directPushes: 12`. Also unit test "TASK-2312 AC-2" |
| 3 | `session reconcile` prints the old merged session and nothing for a young one | `session-command.test.ts` "AC-3" runs the bundled CLI on a fixture DB. It prints exactly `OLD-MERGED`; `YOUNG-MERGED` (1 day old, merged), a direct-push-only decoy and a prefix-id decoy (`TASK-1010` vs `TASK-101`) are absent |
| 4 | No writes | `session-command.test.ts` "AC-4": every `sessions` row is deep-equal before and after. The adapter opens the DB `readonly` |

## Not done
None.

## Needs a human
None.

## Test Plan results
- **Digest for 2026-10-05, before → after:** `mergesToDefault` 53 → 36, plus `directPushes` 12 and 5 bot commits (53 = 36 + 12 + 5). The task predicted 36 would be "well below 47". It is below, but 36 is still a lot. The 47 was measured on 2026-10-07; the repos have been fetched since, so the base count grew to 53.
- **`session reconcile` on the live DB** printed one line: `SESSION-1791523049174-13  TASK-2326  started 2026-10-09  C:\dev\test\JuvenisMaxime.AI  merged: Merge pull request #62 …`. SESSION-1790752497677-22 (TASK-2201), the session the task expected, was not listed because it is no longer ACTIVE.

## Findings
- **Gate noise, not this change.** Two full `pnpm test` runs each failed once, each time in a different timing-sensitive file outside this change:
  - Run 1: `mermaid-check.test.ts` and `workspace-diagram.test.ts`, 30 s hook / 40 s timeouts.
  - Run 2: `schema-version.test.ts`, `initSchema` at 668 ms vs a 500 ms guard.

  All three files pass when run alone, both on this branch and on clean main. They are not recorded as known flakes anywhere.
- **Build side effect.** `pnpm run build` rewrites `docs/adapter-bundle-size.md`. It was reverted, not committed.
- **The worktree was removed.** A clean `C:\dev\choda-deck-task-2312` worktree from 2026-10-05, with no commits, held the branch name. It was removed and the branch recreated from main.
- **The classifier is shared.** `default-branch-log.ts` owns the PR-merge / direct / bot rule, so the digest and `session reconcile` cannot disagree on what counts as a merge.
