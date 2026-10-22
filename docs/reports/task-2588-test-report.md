---
goal: "TASK-2588"
generatedAt: "2026-10-22T06:09:32.834Z"
suite: {"passed":2672,"skipped":56,"failed":0}
testsAdded: 53
unreadableCommits: []
ac: {"covered":65,"weak":0,"open":0,"human":0,"total":65}
smoke: {"na":"goal planned before ## Smoke — companion, adapter and skill changes, no QC service touched"}
regression: [{"task":"TASK-2534","title":"Companion: see what loop runs did, and read any task in Vietnamese"},{"task":"TASK-2559","title":"Runs screen: an item row shows its tests and its commit's code change"}]
---

# Test report — TASK-2588

Generated 2026-10-22T06:09:32.834Z.

## Unit and integration suite

2672 passed, 56 skipped, 0 failed (newest item session with a suite line).

## Tests added by this run

53 test case(s) added across the run's commits.

## Acceptance criteria

65/65 covered · 0 weak · 0 open · 0 waiting on a person.

## Smoke

n/a — goal planned before ## Smoke — companion, adapter and skill changes, no QC service touched

## Regression scope

- TASK-2534 — Companion: see what loop runs did, and read any task in Vietnamese
- TASK-2559 — Runs screen: an item row shows its tests and its commit's code change

## Items

| Task | AC covered | Tests added | Suite line |
|---|---|---|---|
| TASK-2604 CLI: choda-deck deploy scan — build a goal's deploy checklist from its commits and its ## Deploy section | 14/14 | 12 | full suite: 2642 passed, 56 skipped, 0 failed |
| TASK-2605 Deploy ticks: deploy_checks table (synced) and GET/POST /runs/:goal/deploy-checks | 11/11 | 12 | full suite: 2654 passed, 56 skipped, 0 failed |
| TASK-2606 MCP deploy_check: tick or untick a deploy checklist item per environment (for /ichiba-deploy) | 8/8 | 5 | full suite: 2672 passed, 56 skipped, 0 failed |
| TASK-2607 Adapter: GET /runs serves the deploy checklist; POST /secrets/copy returns a secret for the clipboard only | 13/13 | 13 | full suite: 2667 passed, 56 skipped, 0 failed |
| TASK-2608 [companion] Deploy checklist and Waiting on you tabs: QC/Prod ticks, Open, Copy, Copy value | 14/14 | 11 | full suite: 1195 passed, 0 skipped, 0 failed |
| TASK-2609 Skills: plans write ## Deploy; autopilot writes the deploy checklist at run end; /ichiba-deploy reads it and ticks through deploy_check | 5/5 | 0 | grep: all 5 patterns present at a9b9fd3 |
