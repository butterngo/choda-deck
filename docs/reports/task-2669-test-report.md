---
goal: "TASK-2669"
generatedAt: "2026-10-23T05:55:27.024Z"
suite: {"passed":2708,"skipped":56,"failed":0}
testsAdded: 47
unreadableCommits: []
ac: {"covered":41,"weak":0,"open":25,"human":5,"total":71}
smoke: {"env":"local","base":"http://127.0.0.1:7348 (run-branch dist/companion-server.cjs over a snapshot of the real DB; the live :7338 service was not touched)","build":"36f468a (choda-deck) + 1536237 (companion, vite dev on :5199)","ranAt":"2026-10-23T05:55:22.320Z","checks":[{"name":"daily report","call":"GET /daily-report","expect":"200, coverage.total equals the number of active workspaces (30), today.focus has one entry per project (14)","got":"200, coverage.total 30 (scanned 25), today.focus 14","ok":true},{"name":"bad date","call":"GET /daily-report?date=bad","expect":"400, error names the date","got":"400, {\"error\":\"invalid date: bad\"}","ok":true},{"name":"landing","call":"open the companion at #/ (Playwright, 1440x1000)","expect":"lands on /today","got":"#/today, h1 Today, sections coverage/yesterday/focus/outstanding in order, first sidebar link Today; screenshot C:/temp/playwright/smoke-today-TASK-2669.png","ok":true},{"name":"NFR response time","call":"GET /daily-report on 30 workspaces / 14 projects","expect":"< 3000 ms (TASK-2669 NFR, assumed)","got":"8960 ms","ok":false}],"data":[]}
regression: []
---

# Test report — TASK-2669

Generated 2026-10-23T05:55:27.024Z.

## Unit and integration suite

2708 passed, 56 skipped, 0 failed (newest item session with a suite line).

## Tests added by this run

47 test case(s) added across the run's commits.

## Acceptance criteria

41/71 covered · 0 weak · 25 open · 5 waiting on a person.

## Smoke

3/4 passed on local (http://127.0.0.1:7348 (run-branch dist/companion-server.cjs over a snapshot of the real DB; the live :7338 service was not touched), build 36f468a (choda-deck) + 1536237 (companion, vite dev on :5199), ran 2026-10-23T05:55:22.320Z).

| Check | Call | Expect | Got | Result |
|---|---|---|---|---|
| daily report | GET /daily-report | 200, coverage.total equals the number of active workspaces (30), today.focus has one entry per project (14) | 200, coverage.total 30 (scanned 25), today.focus 14 | pass |
| bad date | GET /daily-report?date=bad | 400, error names the date | 400, {"error":"invalid date: bad"} | pass |
| landing | open the companion at #/ (Playwright, 1440x1000) | lands on /today | #/today, h1 Today, sections coverage/yesterday/focus/outstanding in order, first sidebar link Today; screenshot C:/temp/playwright/smoke-today-TASK-2669.png | pass |
| NFR response time | GET /daily-report on 30 workspaces / 14 projects | < 3000 ms (TASK-2669 NFR, assumed) | 8960 ms | FAIL |

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
