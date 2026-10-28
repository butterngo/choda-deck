---
goal: "TASK-2854"
generatedAt: "2026-10-28T17:44:41.903Z"
suite: {"passed":1270,"skipped":0,"failed":0}
testsAdded: 42
unreadableCommits: []
ac: {"covered":35,"weak":0,"open":0,"human":0,"total":35}
smoke: {"env":"local","base":"http://127.0.0.1:7399 (run-branch dist/companion-server.cjs, CHODA_DATA_DIR=C:/dev/choda-deck/data)","build":"ab4bd6f","ranAt":"2026-10-28T17:44:34Z","checks":[{"name":"live agents","call":"GET /agents","expect":"200, includes the Claude Code session running this smoke, unreadable is a number","got":"200, 2 agents, includes 96605b28, unreadable 0","ok":true},{"name":"workspace processes","call":"GET /processes?workspaceId=main","expect":"200, a process whose cmdline contains companion-server.cjs","got":"200, 11 processes, companion-server.cjs present","ok":true},{"name":"unknown workspace","call":"GET /processes?workspaceId=zz_test_TASK-2854_1","expect":"404 {error:'unknown workspace'}","got":"404 {\"error\":\"unknown workspace\"}","ok":true},{"name":"runs carry waiting","call":"GET /runs","expect":"200, every run has a waiting key","got":"200, 43 runs, all carry waiting; TASK-2854 waiting=null","ok":true},{"name":"Runs screen","call":"open Runs in the companion web","expect":"Live section lists agents; no error banner","got":"not run — visual check in the app, left to Butter after the web rebuild","ok":false}],"data":[]}
regression: [{"task":"TASK-2534","title":"Companion: see what loop runs did, and read any task in Vietnamese"},{"task":"TASK-2559","title":"Runs screen: an item row shows its tests and its commit's code change"},{"task":"TASK-2585","title":"Runs: every run's goal is tied to a feature, shown on the run card"},{"task":"TASK-2586","title":"Each task gets a sequence diagram and its acceptance criteria are paired with the tests that ran"},{"task":"TASK-2587","title":"Each run ends with a test report, including a smoke test on QC or locally"},{"task":"TASK-2588","title":"Each run carries a deploy checklist, and everything Butter must run opens and copies from the companion"}]
suites: [{"workspaceId":"choda-deck-companion","passed":1270,"skipped":0,"failed":0},{"workspaceId":"main","passed":2847,"skipped":56,"failed":0}]
---

# Test report — TASK-2854

Generated 2026-10-28T17:44:41.903Z.

## Unit and integration suite

1270 passed, 0 skipped, 0 failed (newest item session with a suite line).

| Workspace | Passed | Skipped | Failed |
|---|---|---|---|
| choda-deck-companion | 1270 | 0 | 0 |
| main | 2847 | 56 | 0 |

## Tests added by this run

42 test case(s) added across the run's commits.

## Acceptance criteria

35/35 covered · 0 weak · 0 open · 0 waiting on a person.

## Smoke

4/5 passed on local (http://127.0.0.1:7399 (run-branch dist/companion-server.cjs, CHODA_DATA_DIR=C:/dev/choda-deck/data), build ab4bd6f, ran 2026-10-28T17:44:34Z).

| Check | Call | Expect | Got | Result |
|---|---|---|---|---|
| live agents | GET /agents | 200, includes the Claude Code session running this smoke, unreadable is a number | 200, 2 agents, includes 96605b28, unreadable 0 | pass |
| workspace processes | GET /processes?workspaceId=main | 200, a process whose cmdline contains companion-server.cjs | 200, 11 processes, companion-server.cjs present | pass |
| unknown workspace | GET /processes?workspaceId=zz_test_TASK-2854_1 | 404 {error:'unknown workspace'} | 404 {"error":"unknown workspace"} | pass |
| runs carry waiting | GET /runs | 200, every run has a waiting key | 200, 43 runs, all carry waiting; TASK-2854 waiting=null | pass |
| Runs screen | open Runs in the companion web | Live section lists agents; no error banner | not run — visual check in the app, left to Butter after the web rebuild | FAIL |

## Regression scope

- TASK-2534 — Companion: see what loop runs did, and read any task in Vietnamese
- TASK-2559 — Runs screen: an item row shows its tests and its commit's code change
- TASK-2585 — Runs: every run's goal is tied to a feature, shown on the run card
- TASK-2586 — Each task gets a sequence diagram and its acceptance criteria are paired with the tests that ran
- TASK-2587 — Each run ends with a test report, including a smoke test on QC or locally
- TASK-2588 — Each run carries a deploy checklist, and everything Butter must run opens and copies from the companion

## Items

| Task | AC covered | Tests added | Suite line |
|---|---|---|---|
| TASK-2855 Adapter: GET /agents lists the live Claude Code sessions with status, last activity and subagents | 5/5 | 8 | full suite: 2821 passed, 56 skipped, 0 failed |
| TASK-2856 Adapter: GET /processes lists a workspace's processes, memory, listening ports and the .NET ports it should listen on | 6/6 | 8 | full suite: 2829 passed, 56 skipped, 0 failed |
| TASK-2857 Adapter: GET /runs marks a run whose Claude Code session is waiting on Butter (Run.waiting) | 5/5 | 6 | full suite: 2835 passed, 56 skipped, 0 failed |
| TASK-2858 Web (companion): Runs card shows "Waiting on you since HH:MM" from Run.waiting | 3/3 | 3 | full suite: 1266 passed, 0 skipped, 0 failed |
| TASK-2859 Companion: file one [monitor] inbox notice when a run has waited on Butter for 20 min (rule-based, no model) | 7/7 | 7 | full suite: 2842 passed, 56 skipped, 0 failed |
| TASK-2860 Assistant: read-only tools get_agents and get_processes, redacted and capped, kept off the remote allowlist | 5/5 | 6 | full suite: 2847 passed, 56 skipped, 0 failed |
| TASK-2861 Web (companion): Live section on the Runs screen shows running agents, workspace processes and expected ports | 4/4 | 4 | full suite: 1270 passed, 0 skipped, 0 failed |
