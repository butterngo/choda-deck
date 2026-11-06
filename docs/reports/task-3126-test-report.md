---
goal: "TASK-3126"
generatedAt: "2026-11-06T15:50:00.723Z"
suite: {"passed":2907,"skipped":57,"failed":0}
testsAdded: 41
unreadableCommits: ["d8c027a"]
ac: {"covered":40,"weak":0,"open":7,"human":2,"total":49}
smoke: {"env":"local","base":"node C:/dev/choda-deck.worktrees/autopilot-TASK-3126/dist/cli.cjs (CHODA_DATA_DIR=C:/dev/choda-deck/data)","build":"feb751c","ranAt":"2026-11-06T15:49:54.510Z","checks":[{"name":"weekly active projects","call":"activity week --json","expect":"exit 0, JSON with limit: 4 and a non-empty active","got":"exit 0, limit 4, active 10 (top: juvenis-maxime 1490, ba-nghiep 1090, mavue-studio 990, tms 785)","ok":true},{"name":"gate on a picked project","call":"rules check choda-deck --json","expect":"exit 0 or 3, JSON with verdict and reasons","got":"exit 3, verdict blocked, reasons: rule 1, rule 2","ok":true}],"data":[]}
regression: []
suites: [{"workspaceId":"main","passed":2907,"skipped":57,"failed":0}]
---

# Test report — TASK-3126

Generated 2026-11-06T15:50:00.723Z.

## Unit and integration suite

2907 passed, 57 skipped, 0 failed (newest item session with a suite line).

## Tests added by this run

41 test case(s) added across the run's commits.

Commits not readable here: d8c027a.

## Acceptance criteria

40/49 covered · 0 weak · 7 open · 2 waiting on a person.

## Smoke

2/2 passed on local (node C:/dev/choda-deck.worktrees/autopilot-TASK-3126/dist/cli.cjs (CHODA_DATA_DIR=C:/dev/choda-deck/data), build feb751c, ran 2026-11-06T15:49:54.510Z).

| Check | Call | Expect | Got | Result |
|---|---|---|---|---|
| weekly active projects | activity week --json | exit 0, JSON with limit: 4 and a non-empty active | exit 0, limit 4, active 10 (top: juvenis-maxime 1490, ba-nghiep 1090, mavue-studio 990, tms 785) | pass |
| gate on a picked project | rules check choda-deck --json | exit 0 or 3, JSON with verdict and reasons | exit 3, verdict blocked, reasons: rule 1, rule 2 | pass |

## Regression scope

No other finished task realizes this goal's feature.

## Items

| Task | AC covered | Tests added | Suite line |
|---|---|---|---|
| TASK-3127 activity week CLI: active choda projects per ISO week + pick the week's 4 | 10/10 | 20 | full suite: 2876 passed, 56 skipped, 0 failed |
| TASK-3128 Project purpose field (income \| reputation \| fun) — required on project_add, synced | 8/9 | 0 | — |
| TASK-3129 rules check CLI + week slot swap + /choda-autopilot §2.3 start gate (rules 1 and 2) | 16/16 | 15 | full suite: 2901 passed, 57 skipped, 0 failed |
| TASK-3130 SessionStart hook: warn (never block) when a session opens in a project breaking rule 1 or 2 | 6/7 | 6 | full suite: 2907 passed, 57 skipped, 0 failed |
| TASK-3131 Monday digest: active projects N/4, pick prompt, purpose gaps, rule 3 and 5 questions | 0/7 | 0 | — |
