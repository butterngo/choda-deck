---
goal: "TASK-2669"
generatedAt: "2026-10-23T12:20:32.181Z"
suite: {"passed":1205,"skipped":0,"failed":0}
testsAdded: 57
unreadableCommits: []
ac: {"covered":52,"weak":0,"open":25,"human":5,"total":82}
smoke: {"env":"local","base":"http://127.0.0.1:7348 (run-branch dist/companion-server.cjs over a snapshot of the real DB; the live :7338 service was not touched)","build":"2dcfd58 (choda-deck) + 1434def (companion, vite dev on :5199)","ranAt":"2026-10-23T12:20:31.547Z","checks":[{"name":"daily report","call":"GET /daily-report","expect":"200, coverage.total = 30 active workspaces, today.focus has one entry per project (14)","got":"200, coverage.total 30 (scanned 25), today.focus 14, scannedAt 2026-10-23T12:18:18.634Z, 11383 ms (first call, scans)","ok":true},{"name":"bad date","call":"GET /daily-report?date=bad","expect":"400, error names the date","got":"400, {\"error\":\"invalid date: bad\"}","ok":true},{"name":"NFR response time (warm)","call":"GET /daily-report x3 after the first call","expect":"< 1000 ms each (TASK-2704 AC-7; TASK-2669 NFR < 3000 ms), same coverage.scannedAt as the first call","got":"116 / 123 / 120 ms, scannedAt same/same/same","ok":true},{"name":"fresh rescan","call":"GET /daily-report?fresh=1","expect":"200, coverage.scannedAt later than the cached one","got":"200, scannedAt 2026-10-23T12:18:30.310Z, 3676 ms","ok":true},{"name":"landing","call":"open the companion at #/ (Playwright, 1440x1000, vite dev :5199 -> adapter :7348)","expect":"lands on /today","got":"#/today, h1 Today; coverage strip \"Coverage: 25 of 30 workspaces scanned · scanned just now\"; first /daily-report 356 ms (cached); screenshot C:/temp/playwright/smoke-today-TASK-2705.png","ok":true},{"name":"Rescan","call":"click Rescan on Today","expect":"requests /daily-report?fresh=1 and shows its report","got":"/api/daily-report?fresh=1 issued (3794 ms); strip still reads scanned just now with the new scan","ok":true}],"data":[]}
regression: []
---

# Test report — TASK-2669

Generated 2026-10-23T12:20:32.181Z.

## Unit and integration suite

1205 passed, 0 skipped, 0 failed (newest item session with a suite line).

## Tests added by this run

57 test case(s) added across the run's commits.

## Acceptance criteria

52/82 covered · 0 weak · 25 open · 5 waiting on a person.

## Smoke

6/6 passed on local (http://127.0.0.1:7348 (run-branch dist/companion-server.cjs over a snapshot of the real DB; the live :7338 service was not touched), build 2dcfd58 (choda-deck) + 1434def (companion, vite dev on :5199), ran 2026-10-23T12:20:31.547Z).

| Check | Call | Expect | Got | Result |
|---|---|---|---|---|
| daily report | GET /daily-report | 200, coverage.total = 30 active workspaces, today.focus has one entry per project (14) | 200, coverage.total 30 (scanned 25), today.focus 14, scannedAt 2026-10-23T12:18:18.634Z, 11383 ms (first call, scans) | pass |
| bad date | GET /daily-report?date=bad | 400, error names the date | 400, {"error":"invalid date: bad"} | pass |
| NFR response time (warm) | GET /daily-report x3 after the first call | < 1000 ms each (TASK-2704 AC-7; TASK-2669 NFR < 3000 ms), same coverage.scannedAt as the first call | 116 / 123 / 120 ms, scannedAt same/same/same | pass |
| fresh rescan | GET /daily-report?fresh=1 | 200, coverage.scannedAt later than the cached one | 200, scannedAt 2026-10-23T12:18:30.310Z, 3676 ms | pass |
| landing | open the companion at #/ (Playwright, 1440x1000, vite dev :5199 -> adapter :7348) | lands on /today | #/today, h1 Today; coverage strip "Coverage: 25 of 30 workspaces scanned · scanned just now"; first /daily-report 356 ms (cached); screenshot C:/temp/playwright/smoke-today-TASK-2705.png | pass |
| Rescan | click Rescan on Today | requests /daily-report?fresh=1 and shows its report | /api/daily-report?fresh=1 issued (3794 ms); strip still reads scanned just now with the new scan | pass |

## Regression scope

No other finished task realizes this goal's feature.

## Items

| Task | AC covered | Tests added | Suite line |
|---|---|---|---|
| TASK-2670 Status log: task_status_changes written at TaskRepository.update, plus planDate (05:00 day boundary) | 8/8 | 10 | full suite: 2682 passed, 56 skipped, 0 failed |
| TASK-2671 Workspace scan: git dirty/unmerged and gh PRs per repo, deduped by toplevel, never "clean" when unscanned | 8/8 | 8 | full suite: 2690 passed, 56 skipped, 0 failed |
| TASK-2672 [cancelled 2026-10-23 — focus aggregation replaced the day plan, see TASK-2669] MCP goal_path | 0/6 | 0 | — |
| TASK-2673 Adapter: GET /daily-report — yesterday, outstanding per project and scan coverage, computed live | 9/9 | 9 | full suite: 2708 passed, 56 skipped, 0 failed |
| TASK-2674 [cancelled 2026-10-23 — focus aggregation replaced the day plan, see TASK-2669] Day plan store | 0/8 | 0 | — |
| TASK-2675 [companion] Today view as the landing page: coverage strip, yesterday, focus across all projects, outstanding per project | 8/12 | 11 | full suite: companion pnpm test exit 0 — web 109 files + electron 13 files passed, 0 failed |
| TASK-2676 [cancelled 2026-10-23 — focus aggregation replaced the day plan, see TASK-2669] /daily-report reads the day plan | 0/3 | 0 | — |
| TASK-2677 [cancelled 2026-10-23 — focus aggregation replaced the day plan, see TASK-2669] /plan-tomorrow skill | 0/4 | 0 | — |
| TASK-2679 [cancelled 2026-10-23 — focus aggregation replaced the day plan, see TASK-2669] Companion day plan block | 0/5 | 0 | — |
| TASK-2686 resolveFocus + MCP focus_board: the /choda-task-focus tiers in code, one focus per project for all projects | 8/8 | 9 | full suite: 2699 passed, 56 skipped, 0 failed |
| TASK-2704 Adapter: /daily-report serves the git scan from a per-repo cache (stale-while-revalidate, ?fresh=1) — warm calls under 1 s | 7/7 | 6 | full suite: 2714 passed, 56 skipped, 0 failed |
| TASK-2705 [companion] Today: Rescan asks for a fresh scan, and the coverage strip says how old the git scan is | 4/4 | 4 | full suite: 1205 passed, 0 skipped, 0 failed |
