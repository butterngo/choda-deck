# TASK-1784 — AC verification

Session SESSION-1787663209301-58 · 2026-08-25 · merged as `d0cb3a7` (PR #257)

**6 of 6 ticked.** All machine-class.

| AC | Verdict | Evidence |
|---|---|---|
| AC-1 four distinct states | ✅ | Three on the field, `absent` is the 404; unit tests prove no two collapse |
| AC-2 orphan → `unreachable`, 200 | ✅ | `bf781db` live: 200, readable subject |
| AC-3 on-main → `default-branch` | ✅ | `9bca7ae` live, **differs from AC-2 on the same endpoint** |
| AC-4 absent → 404 | ✅ | `deadbeef` live: 404, valid hex so it genuinely reached the lookup |
| AC-5 under 50 ms | ✅ | **37.8 ms** median in-process, 33% of a 115 ms detail |
| AC-6 TASK-1779 AC-5 disposed | ✅ | Retired, with the reason recorded |

## The default branch is asked for, not assumed

`git symbolic-ref refs/remotes/origin/HEAD`, fallbacks `origin/main` / `origin/master`. This closes INBOX-1887's open question — and `origin/HEAD` is set in **all four** registered workspaces, verified rather than assumed.

When nothing resolves the answer degrades to `branch-only`, **never** `default-branch`. Claiming a commit is merged when we could not check is the direction that misleads.

A unit test proves the ref is used by *name*: a fake reporting `origin/trunk` is queried as `origin/trunk`. A hardcoded `origin/main` would return the right verdict on this repo and fail that test.

## Two measurements I had to throw away

**1.6 ms.** The first AC-5 reading. Too good for a route spawning git subprocesses, so I checked whether `reachability` was even in the response — it was absent. Wrong workspace id (`choda-deck` instead of `main`), so I had been timing 404s. The number was entirely plausible and entirely meaningless.

**The cross-build A/B.** Comparing the new adapter against the old one on port 7338 showed the *new* build faster (147 ms vs 185 ms) despite doing more work — because the two processes were running different build vintages. Replaced with an in-process measurement of `resolveReachability` alone, which is the number the AC actually asks for.

## Suite note — investigated, not waved through

The full local run drops one file to `[vitest-pool] Worker forks emitted error`. No test fails; a worker exits before reporting.

I did not call this a known flake on the skill's say-so. `main` was run three times without this change: **clean, dirty, clean**. The file that drops varies (`http-transport.test.ts`, `sync-phase2.pg.test.ts`) — both resource-heavy, neither related to this diff.

CI settles it: ubuntu, windows and docker all pass the full suite on this PR. The flake is local to this machine.

## Gates

typecheck 0 · affected tests 3 files / 74 tests 0 · lint 0 · build 0
CI on PR #257: all three pass. Merge proven: `d0cb3a7` is an ancestor of `origin/main`.
