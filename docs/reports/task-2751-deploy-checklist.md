---
goal: "TASK-2751"
items: [{"key":"manual:1","phase":"deploy","kind":"manual","title":"in C:\\dev\\choda-deck run the build (it now also builds `dist/assistant-server.cjs`), then stop the adapter node process on :7338 so the Task Scheduler service restarts on the new bundle and spawns the assistant child","why":"From the goal's ## Deploy","workspaceId":null},{"key":"manual:2","phase":"deploy","kind":"manual","title":"release the companion with the dist script in C:\\dev\\choda-deck-companion so the installed app vendors both `companion-server.cjs` and `assistant-server.cjs`","why":"From the goal's ## Deploy","workspaceId":null},{"key":"manual:3","phase":"after","kind":"manual","title":"confirm `<dataDir>/assistant.db` exists and holds every pre-release chat before anyone relies on deleting the old tables later","why":"From the goal's ## Deploy","workspaceId":null},{"key":"manual:4","phase":"after","kind":"manual","title":"two weeks after release, read the token totals of real chats: regenerate/edit count again, so check the 300k default budget still fits","why":"From the goal's ## Deploy","workspaceId":null}]
---

# Deploy checklist — TASK-2751

## Deploy

| Item | Why | File / copy |
|---|---|---|
| in C:\dev\choda-deck run the build (it now also builds `dist/assistant-server.cjs`), then stop the adapter node process on :7338 so the Task Scheduler service restarts on the new bundle and spawns the assistant child | From the goal's ## Deploy | — |
| release the companion with the dist script in C:\dev\choda-deck-companion so the installed app vendors both `companion-server.cjs` and `assistant-server.cjs` | From the goal's ## Deploy | — |

## After deploy

| Item | Why | File / copy |
|---|---|---|
| confirm `<dataDir>/assistant.db` exists and holds every pre-release chat before anyone relies on deleting the old tables later | From the goal's ## Deploy | — |
| two weeks after release, read the token totals of real chats: regenerate/edit count again, so check the 300k default budget still fits | From the goal's ## Deploy | — |
