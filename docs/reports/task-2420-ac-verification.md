# TASK-2420 — AC verification

**Task:** choda-autopilot skill: per-item cycle — one commit per item, stash on failure, scope guard, resume
**Parent:** TASK-2416 · **PR:** butterngo/choda-skills#18 · **Merge commit:** `32eb472` (ancestor of origin/main, proven)
**Run:** /choda-burn-backlog, label `autopilot`, 2026-10-12

## Fixture
- Repo `C:\tmp\ac11-fixture` (registered workspace `ac11-fixture`), with a bare origin at `C:\tmp\ac11-fixture-origin.git` and real gate scripts (typecheck = `node --check src/*.js`).
- Goal TASK-2427 with four subtasks:
  - TASK-2428 alpha, high
  - TASK-2429 broken (`const = ;`), medium
  - TASK-2430 delta, low
  - TASK-2432 gamma, which depends on TASK-2429
- Outside the goal: TASK-2431, READY + critical.

## Done (8/8)

| # | Criterion | Evidence |
|---|---|---|
| 1 | 1 commit per finished subtask | `git log origin/main..HEAD --grep`: TASK-2428 → 1, TASK-2430 → 1; TASK-2429 → 0 and TASK-2432 → 0 (blocked / skipped) |
| 2 | Finished subtasks IMPLEMENTED | TASK-2428 and TASK-2430 IMPLEMENTED; neither set to DONE |
| 3 | Stash `autopilot-blocked-<TASK>` | typecheck failed twice (`SyntaxError: Unexpected token '='`) → `stash@{0}: … autopilot-blocked-TASK-2429` |
| 4 | Clean tree after failure | `git status --porcelain` → 0 lines (`stash -u`) |
| 5 | One 🔴 notice naming the item and its dependents | INBOX-2218, naming dependent TASK-2432 and the stash |
| 6 | Next independent item still runs | SESSION-1791812498931-30 for TASK-2430, committed |
| 7 | No session for the outside READY critical task | TASK-2431: 0 sessions |
| 8 | Restart adds no duplicate commit | Stopped after TASK-2428's commit with its session still open. Re-entry at §0 took the §5.2 path (IN-PROGRESS + active session + 1 commit) and closed the item without committing; the count stayed 1 |

## Not done
None.

## Needs a human
None.

## Findings
- **Contract facts that shaped the design.**
  - `inbox_convert` takes no `parentTaskId`, so a converted item needs a follow-up `task_update`.
  - `session_cancel` leaves the task IN-PROGRESS, so the stash, not the status, is what marks an item blocked.
- **Simulated, not real, interruption (AC-8).** The interruption was a re-entry at §0, not a killed process. The resume rule reads only git and DB state, so the path exercised is the one a real restart takes.
- **Pacing not exercised.** The items ran inside one burn-backlog firing, because ScheduleWakeup is shared with the outer loop, so the 300 s re-arm (§5.7) was not tested.
- **Inbox conversion not exercised.** No raw inbox item related to the fixture goal, so §5.3.1 (convert + re-parent) has no run evidence yet.
- **Blocker for TASK-2421.** Its end-of-run step opens PRs with `gh`, which needs a GitHub-hosted repo. The fixture's origin is a local bare repo. TASK-2421 needs a GitHub fixture repo, and creating one is an outward action that needs Butter's go-ahead.
- **Fixture kept on purpose.** Goal TASK-2427 (2 items IMPLEMENTED, TASK-2429 blocked, TASK-2432 skipped) and the `ac11-fixture` repo are left in place for TASK-2421 to reuse. The outside task TASK-2431 is cancelled, and notices INBOX-2217..2219 are archived.
