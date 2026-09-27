# TASK-2155 — AC verification

Scheduler installer: `\ChodaActivityDigest` runs `/daily-digest` at logon and 09:00.
Verified 2026-09-27 on the dev machine, from the main checkout on branch
`feat/task-2155-activity-digest-scheduler` (251812b), PR #316.

**Result: 7/7 ticked. 0 need a human.**

| AC | Verdict | Evidence |
|---|---|---|
| AC-1 | pass | `schtasks /query /tn \ChodaActivityDigest /xml` → `<LogonTrigger>` and `<CalendarTrigger>` with `StartBoundary 2026-09-27T09:00:00+07:00` |
| AC-2 | pass | `data/activity-digest-launcher.cmd` calls `C:\Users\hngo1_mantu\AppData\Roaming\fnm\node-versions\v24.15.0\installation\claude.cmd` — absolute, no `fnm_multishells` |
| AC-3 | pass | `data/artifacts/activity/2026-09-26.json` absent before (the script exits 3 if it exists); `schtasks /run` at 14:06:10 → file present after 76 s. The catch-up also wrote 09-20..09-25. `LastTaskResult 0` |
| AC-4 | pass | `grep -iE "permission\|requires approval\|approve\|not allowed\|denied" data/logs/activity-digest.log` → exit 1. The log holds the full run, start 14:06:10 to `exit 0` 14:08:40 |
| AC-5 | pass | task present (AC-1) → `--uninstall` → `Get-ScheduledTask -TaskName ChodaActivityDigest` returns nothing |
| AC-6 | pass | both files read before uninstall; after it `Test-Path` is False for the launcher `.cmd` and the `.vbs` |
| AC-7 | pass | `git worktree add C:\tmp\wt-2155-ac7`, run without `--data-dir` → exit 1, `refusing to run from the git worktree C:\tmp\wt-2155-ac7`; `Get-ScheduledTask` → nothing; worktree removed |

Final state: reinstalled, `Get-ScheduledTask` state `Ready`.

## Steps

Order from the Test Plan: AC-7 → install → AC-1..AC-4 → uninstall → AC-5, AC-6 → reinstall.

## Findings

- **The claude path pins a node version.** fnm's `node-versions\v24.15.0\installation` is stable across shells,
  but a node upgrade through fnm leaves the task pointing at the old version's `claude.cmd`. Re-run the
  installer after changing the default node version.
- **CI flake on the first push.** ubuntu `build-and-test` reported 178/178 test files passing and still went
  red on one unhandled `pg` error `57P01` (the Postgres testcontainer terminating a pooled connection at
  teardown). A rerun of the failed job was green. This PR touches only `scripts/`.
- **The skill's own report of a local slip.** The run's output says a prompt-text redaction used the wrong
  field name in its working reads; it states nothing of that text reached the thread or the inbox. That
  claim is what TASK-2161 AC-4 checks mechanically.
