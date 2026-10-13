# TASK-2421 — AC verification

**Task:** choda-autopilot skill: end of run — one PR per repo, notices, DONE promotion after Butter merges
**Parent:** TASK-2416 · **PRs:** butterngo/choda-skills#20 (`c2ec679`), #21 follow-up fix (`19f4891`), both merges proven
**Fixture repo:** `butterngo/ac11-fixture` (private, created by Butter 2026-10-13), checked out at `C:\tmp\ac11-fixture`

## Done (8/8)

| # | Criterion | Evidence |
|---|---|---|
| 1 | Exactly one open PR per repo the run committed to | Goal TASK-2427 → `gh pr list --head autopilot/TASK-2427-2026-10-12 --state open` returned exactly PR #1. §6.1 first checked `--state all` and found 0 |
| 2 | The loop did not merge | `--state merged` returned 0 at queue end |
| 3 | One 🟢 notice with every PR URL | INBOX-2222 |
| 4 | After the merge, all-machine items become DONE | PR #1 was rebase-merged **by Claude at Butter's explicit instruction** ("bạn làm đi"), not by the loop. Merge proof: `0b744d2` is an ancestor of origin/main. §6.3 then set TASK-2428 and TASK-2430 to DONE |
| 5 | An item with a human-class AC stays IMPLEMENTED | TASK-2451 (`(human)` AC unticked) stayed IMPLEMENTED |
| 6 | One ⚪ notice naming it | INBOX-2225 |
| 7 | A PR closed unmerged → one 🔴 notice with its URL | Goal TASK-2447 → PR #2 closed → INBOX-2224 |
| 8 | No status change after the close | TASK-2448 stayed IMPLEMENTED, `updatedAt` unchanged |

## Not done
None.

## Needs a human
None for this task. TASK-2451's human criterion is a fixture, not a real check.

## Findings
- **Spec gap found and fixed (#21).** §6.1 reused an existing PR without pushing. TASK-2451 was committed after PR #1 opened, so without a push it would have been left out of the merge while its task looked finished. §6.1 now pushes when the reused PR is OPEN and the local branch is ahead.
- **AC-5 needed a new fixture item.** The original fixture had no item with a human-class criterion, so TASK-2451 was added to the goal before the merge.
- **Rebase merge kept one commit per item.** main now reads `5fd83c0` alpha, `ada35bb` delta and `0b744d2` zeta, one commit each.
- **Branch handling.** The closed-PR branch `autopilot/TASK-2447-2026-10-13` was kept, as §6.4 requires. The merged run branch was pruned.
- **The repo creation was blocked for the agent.** The permission classifier rejected `gh repo create`, and Butter created the repo instead. Deleting `butterngo/ac11-fixture` is left to Butter.
