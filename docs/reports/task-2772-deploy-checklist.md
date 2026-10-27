---
goal: "TASK-2772"
items: [{"key":"manual:1","phase":"deploy","kind":"manual","title":"in C:\\dev\\choda-deck run the build, then stop the :7338 adapter node process so the Task Scheduler launcher restarts it on the new bundle (the GET /runs `suites` field)","why":"From the goal's ## Deploy","workspaceId":null},{"key":"manual:2","phase":"deploy","kind":"manual","title":"in C:\\dev\\choda-deck-companion run the dist script and install the result locally, so the web changes and the vendored adapter reach the app","why":"From the goal's ## Deploy","workspaceId":null},{"key":"manual:3","phase":"after","kind":"manual","title":"release the companion with `dist:publish` only when Butter asks","why":"From the goal's ## Deploy","workspaceId":null}]
---

# Deploy checklist — TASK-2772

## Deploy

| Item | Why | File / copy |
|---|---|---|
| in C:\dev\choda-deck run the build, then stop the :7338 adapter node process so the Task Scheduler launcher restarts it on the new bundle (the GET /runs `suites` field) | From the goal's ## Deploy | — |
| in C:\dev\choda-deck-companion run the dist script and install the result locally, so the web changes and the vendored adapter reach the app | From the goal's ## Deploy | — |

## After deploy

| Item | Why | File / copy |
|---|---|---|
| release the companion with `dist:publish` only when Butter asks | From the goal's ## Deploy | — |
