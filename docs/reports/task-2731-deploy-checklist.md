---
goal: "TASK-2731"
items: [{"key":"manual:1","phase":"deploy","kind":"manual","title":"in C:\\dev\\choda-deck run `pnpm run build:companion`, then stop the adapter node process on :7338 so the service restarts on the new bundle","why":"From the goal's ## Deploy","workspaceId":null},{"key":"manual:2","phase":"deploy","kind":"manual","title":"release the companion (`pnpm run dist` in C:\\dev\\choda-deck-companion) so the installed app vendors the adapter with the /assistant routes","why":"From the goal's ## Deploy","workspaceId":null},{"key":"manual:3","phase":"after","kind":"manual","title":"two weeks after release, read the token totals of real chats and confirm the 300k default budget in the ADR amendment still fits","why":"From the goal's ## Deploy","workspaceId":null}]
---

# Deploy checklist — TASK-2731

## Deploy

| Item | Why | File / copy |
|---|---|---|
| in C:\dev\choda-deck run `pnpm run build:companion`, then stop the adapter node process on :7338 so the service restarts on the new bundle | From the goal's ## Deploy | — |
| release the companion (`pnpm run dist` in C:\dev\choda-deck-companion) so the installed app vendors the adapter with the /assistant routes | From the goal's ## Deploy | — |

## After deploy

| Item | Why | File / copy |
|---|---|---|
| two weeks after release, read the token totals of real chats and confirm the 300k default budget in the ADR amendment still fits | From the goal's ## Deploy | — |
