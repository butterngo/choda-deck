---
type: learning
title: vitest can report PASS while silently not running test files — check the FILE count, not just the test count
projectId: choda-deck
scope: project
refs:
  - path: vitest.config.ts
    commitSha: 3b4684a0f8e76b145ff201c8c150c5cae4027cad
  - path: package.json
    commitSha: 3b4684a0f8e76b145ff201c8c150c5cae4027cad
  - path: extension/lib/snapshot.test.js
    commitSha: 3b4684a0f8e76b145ff201c8c150c5cae4027cad
  - path: extension/lib/selector.test.js
    commitSha: 3b4684a0f8e76b145ff201c8c150c5cae4027cad
createdAt: 2026-07-30
lastVerifiedAt: 2026-07-30
---

## Trigger

The suite reports a green run with a plausible-looking number ("56 passed"), and you cite it
as evidence the work is done. Some test files never executed. Nothing in the summary says so —
the count is simply the total of the files that *did* run.

## Context

During TASK-1423 the local `node_modules` was missing `happy-dom`. Two extension test files
(`snapshot.test.js`, `selector.test.js`) need a DOM environment, so their workers failed to
start. vitest reported **"56 passed"** with 2 unhandled errors buried above the summary — and
exit code 0. After `pnpm install` restored the dep, the same command reported an honest
**70/70**.

A green run said nothing about 14 tests that were never executed, in files specifically
covering the DOM-dependent half of the extension.

## Business rule

**A test count is only evidence if the FILE count matches what is on disk.** Before citing a
suite result as proof of anything:

1. Compare vitest's `Test Files N passed (N)` against the number of matching files on disk
   (`extension/**/*.test.js`, `src/**/*.test.ts`, `scripts/**/*.test.ts` per
   `vitest.config.ts`'s `include`).
2. Treat any "unhandled error" line above the summary as a **failure**, regardless of exit
   code. A worker that cannot start is not a passing test.
3. Be especially suspicious after dependency changes, a fresh clone, a new worktree, or a
   branch switch that touched `package.json` — all of them can leave a `node_modules` that
   satisfies most files and starves a few.

Corollary for reporting: "N tests pass" is a weaker claim than it sounds. If the file count
wasn't checked, say what was actually run rather than implying full coverage.

## Resolution

Restore the missing devDep (`pnpm install`) and re-run; confirm the file count moved. There is
no config that makes this loud today — the open question from TASK-1423's handoff was whether
vitest can be made to fail hard on a worker that cannot start, rather than passing with
unhandled errors. Until then the check is manual and belongs in the verification step, not
after it.

## Related

- Same family as the ADR-023-era caution that a green local run is not a green CI run; this is
  narrower and worse, because the local run is not even a green *local* run.
- `feedback_ac_post_build_smoke` (auto-memory): for build-coupled features, unit tests passing
  is not the same as the built artifact working — a parallel case of a signal that reads as
  more complete than it is.
