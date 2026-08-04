---
type: learning
title: vitest can report PASS while silently not running test files — check the FILE count, not just the test count
projectId: choda-deck
scope: project
refs:
  - path: vitest.config.ts
    commitSha: 306045e706dad87bc85ee857b43c2154a7f69479
  - path: scripts/test.mjs
    commitSha: 306045e706dad87bc85ee857b43c2154a7f69479
  - path: scripts/lib/test-files.mjs
    commitSha: 306045e706dad87bc85ee857b43c2154a7f69479
  - path: extension/lib/snapshot.test.js
    commitSha: 306045e706dad87bc85ee857b43c2154a7f69479
  - path: extension/lib/selector.test.js
    commitSha: 306045e706dad87bc85ee857b43c2154a7f69479
createdAt: 2026-07-30
lastVerifiedAt: 2026-08-03
---

## Trigger

The suite reports a green run with a plausible-looking number ("56 passed"), and you cite it
as evidence the work is done. Some test files never executed. Nothing in the summary says so —
the count is simply the total of the files that *did* run.

## Context

During TASK-1423 the local `node_modules` was missing `happy-dom`. Two extension test files
(`snapshot.test.js`, `selector.test.js`) need a DOM environment, so their workers failed to
start. vitest reported **"56 passed"** with 2 unhandled errors buried above the summary. After
`pnpm install` restored the dep, the same command reported an honest **70/70**.

**Correction (TASK-1514, 2026-07-30).** An earlier version of this entry said that run exited
**0**. It does not. Reproduced deliberately by removing `happy-dom`: vitest exits **1**, in both
`node scripts/test.mjs run` and a bare `node_modules/vitest/vitest.mjs run`. `git log` confirms
vitest has not been version-bumped since April, so it behaved the same way during the original
incident. The run was never green — **the exit code was masked by a pipe** (`… | tail`), the
same trap recorded in the auto-memory about piping gating commands. The visible summary line
said "passed", nobody saw `$?`, and a red run got recorded as green.

That distinction matters: the defect was never "vitest passes when it shouldn't." It was "the
only honest signal is one nobody was looking at."

### Two distinct ways a file silently disappears

1. **A missing environment dependency** — the `happy-dom` case above.
2. **An accidental environment pragma** — vitest scans the *whole source* of a test file for
   `@vitest-environment <name>`, not just the header. A file that merely *mentions* the pragma
   in a comment or string makes vitest try to load an environment by that name, the worker
   fails to start, and the file vanishes. This bit TASK-1514's own new test file, which
   mentioned the pragma while describing this very bug — the suite reported 119 passed with
   that file never running. **Do not write the pragma verbatim in prose inside a test file.**

## Business rule

**A test count is only evidence if the FILE count matches what is on disk.**

As of TASK-1514 this is enforced automatically: `scripts/test.mjs` runs vitest with a JSON
reporter, globs the include patterns off disk, and **fails with the named missing files** when
anything on disk did not run. The include patterns live in `scripts/lib/test-files.mjs` and
`vitest.config.ts` imports them, so the globbed set and the audited set cannot drift.

Still true, and still on you:

1. Treat any "unhandled error" line above the summary as a **failure**, regardless of what the
   summary says.
2. **Run gating commands bare, never piped.** A pipe replaces the command's exit code with the
   pipe's — this is what hid the original failure for a whole session.
3. Be suspicious after dependency changes, a fresh clone, a new worktree, or a branch switch
   touching `package.json` — all can leave a `node_modules` that satisfies most files and
   starves a few.

Corollary for reporting: "N tests pass" is a weaker claim than it sounds. Say what actually
ran rather than implying full coverage.

## Resolution

Restore the missing devDep (`pnpm install`) and re-run; the guard now names exactly which files
were skipped, and its message survives a pipe even when the exit code does not.

The open question from TASK-1423's handoff — "can vitest be made to fail hard on a worker that
cannot start?" — is answered: it already did. The guard exists for the harder half, a file that
disappears *without* erroring, which no exit code would ever catch.

Guard limitation worth knowing: its model of vitest's CLI file filters is substring-only. A
regex positional filter yields an empty expected set and the guard **skips** rather than fails —
deliberate, since a false red on a healthy run trains people to ignore it.

## Related

- Same family as the caution that a green local run is not a green CI run; this is narrower and
  worse, because the local run was not even a green *local* run.
- `feedback_ac_post_build_smoke` (auto-memory): unit tests passing is not the same as the built
  artifact working — a parallel case of a signal reading as more complete than it is.
