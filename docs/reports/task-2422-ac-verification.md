# TASK-2422 — AC verification

**Task:** choda-burn-backlog files a `[loop:<ws>]` notice when it stops
**Parent:** TASK-2416 · **PR:** butterngo/choda-skills#19 · **Merge commit:** `30aa847` (ancestor of origin/main, proven)
**Run:** /choda-burn-backlog, label `autopilot`, 2026-10-12

## Done (1/2)

| # | Criterion | Evidence |
|---|---|---|
| 1 | An untracked file the run did not create → exactly one raw `[loop:<ws>] 🔴` notice naming it | `stray-2422.txt` appeared in `ac11-fixture` between firings (the tree was clean the firing before). Result: INBOX-2220 `[loop:ac11-fixture] 🔴 run: unfamiliar dirty tree` / `?? stray-2422.txt`, plus a PushNotification |

## Needs a human (1)

| # | Criterion | Why not ticked | How to check |
|---|---|---|---|
| 2 | The notice appears on the companion "Needs your decision" screen with Dismiss and no Approve | Human-class. The installed companion 0.19.1 predates companion #188 (TASK-2419) | Run a companion build that includes #188, open "Needs your decision", find INBOX-2220 under "From your loops", and confirm only Dismiss is shown. Dismiss it afterwards. INBOX-2220 is left **raw** on purpose for this check |

## Findings
- **The AC's wording does not match the skill's rules.** AC-1 says "starting with an untracked file". But burn-backlog §2.2 lets dirt that already exists at the first start pass with a flag, and only *new* unfamiliar dirt mid-run halts (§12). The probe therefore engineered the mid-run case. The AC was not reworded; the gap is recorded here instead.
- **Uncommitted work protected.** `choda-burn-backlog/SKILL.md` carried someone else's uncommitted §0.0 saved-profile section, 19 lines. The commit was built from the HEAD version with `git hash-object` + `update-index`, so that section is not in the PR and is still uncommitted in the working copy after the merge.
- **Executor caveat.** The probe firing was executed by the agent that wrote the rule.
