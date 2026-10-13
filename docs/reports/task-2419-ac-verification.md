# TASK-2419 — AC verification

**Task:** Companion DecideView: loop notices show Dismiss only, never Approve → task
**Parent:** TASK-2416 · **PR:** butterngo/choda-deck-companion#188 · **Merge commit:** `8560c02` (ancestor of origin/main, proven)
**Run:** /choda-burn-backlog, label `autopilot`, 2026-10-12

## Done (3/3)

| # | Criterion | Evidence |
|---|---|---|
| 1 | A `source: 'loop'` row renders `decide-archive-<id>` and no `decide-convert-<id>` | `decide-view.test.tsx` "TASK-2419 AC-1". Mutation check: with the condition forced to `true` the test fails (`expected <button> to be null`) |
| 2 | A `source: 'improve'` row still renders `decide-convert-<id>` | "TASK-2419 AC-2", next to a loop row |
| 3 | Companion web `typecheck` and `test` exit 0 | typecheck 0, test 0 (96 files / 872 tests); lint 0, build 0 |

## Not done
None.

## Needs a human
None for this task. TASK-2422 AC-2 (seeing a real notice on the screen) covers the visual check.

## Findings
- **Scope gap found and closed.** `DecideView` split items into blocks by source (digest / improve / improve-note), so a `loop` item matched no filter and would never have rendered, Approve button or not. A "From your loops" block now sits under "Waiting on you".
- **No CI.** The companion repo has no CI workflows, so the PR's merge rested on the local gates.
- **Pre-existing dirt left untouched.** The checkout carries unrelated changes (8 `docs/knowledge/*` files and `.choda/`). Only the 3 files touched by this task were staged.
