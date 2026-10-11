# TASK-2382 — AC verification

Daily desktop reminder in the companion's Electron main process
(`electron/attention-reminder.cjs`, wired in `electron/main.cjs`). Merged in
choda-deck-companion PR #177 (`6122a85`); the repo has no CI workflows.

## Done — 3/4

| # | Criterion | Evidence |
|---|---|---|
| 0 | 3 items (1 digest) at 09:05 → one notification naming "1 từ daily digest"; same day again → none; 0 → none; next day → one again | `attention-reminder.test.cjs`, fake clock/fetch/store. The body is `3 mục đang chờ anh quyết (1 từ daily digest)`; a 0-count tick does not use up the day, so items arriving at 11:00 still remind |
| 1 | Clicking opens `#/decide` | unit test on `onClick`; main wires it to `showWindow()` + `location.hash = "#/decide"` |
| 2 | Unreachable adapter → nothing, day not marked | unit test: a fetch that throws ECONNREFUSED returns `skipped:unreachable`; the next reachable tick reminds |

## Needs a human — 1

The real notification in the packaged app (TASK-2391, second line).

## Findings

- Checked at start and every 5 minutes (`setInterval(...).unref()`), so "09:05" means "the first
  check at or after 09:05 that finds items". A check at app start may remind before 09:05. Both
  are deliberate.
- The day is persisted in `userData/attention-reminder.json`, so restarting the app does not
  repeat the reminder.
- Full suite: web 95/95 and electron 11/11 files.
