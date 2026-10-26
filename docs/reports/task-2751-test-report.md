---
goal: "TASK-2751"
generatedAt: "2026-10-26T07:58:40.597Z"
suite: {"passed":2799,"skipped":56,"failed":0}
testsAdded: 91
unreadableCommits: []
ac: {"covered":88,"weak":0,"open":0,"human":3,"total":91}
smoke: {"env":"local","base":"run-branch adapter (dist/companion-server.cjs) on port 0 over a copy of C:\\dev\\choda-deck\\data — not the installed app","build":"043d5ab","ranAt":"2026-10-26T07:57:35.631Z","checks":[{"name":"service is up under the adapter","call":"GET /assistant/chats + process list","expect":"200; assistant-server.cjs child of the adapter pid","got":"status 200; 1 assistant-server.cjs child(ren) of pid 25768","ok":true},{"name":"old chats migrated","call":"GET /assistant/chats vs shared assistant_chats","expect":"same ids, titles, tokensUsed; same message counts","got":"9 pre-release chats, 9 in assistant.db","ok":true},{"name":"streaming + tools","call":"POST /assistant/chats/:id/messages \"what is the status of TASK-2751?\"","expect":"text/event-stream, several deltas, get_task ok, reply names READY","got":"text/event-stream; charset=utf-8; 136 deltas, first after 2033 ms; steps [\"get_task\"]; reply: **TASK-2751** is **READY** and marked **high priority**.\n\n- **Assignee:** None\n- **Blocked by:** None\n- **Due date:** None\n- **Last updated:** October 26, 2026\n","ok":true},{"name":"general chat","call":"POST messages \"Dịch sang tiếng Anh: tôi đang bận\"","expect":"an English translation, 0 steps, no refusal","got":"steps 0; reply: I’m busy.","ok":true},{"name":"chat actions","call":"send, PATCH, regenerate, edit M1, DELETE on zz_test_TASK-2751_1","expect":"each takes effect; deleted chat 404 after","got":"rename 200; regen done; edit done; rows after edit 2; delete 204; get after 404","ok":true},{"name":"markdown","call":"POST messages \"a small TypeScript function in a code block\"","expect":"reply holds a ``` fenced block (the web renders it with Copy)","got":"fenced block: true; tokens 1224","ok":true}],"data":["chat CHAT-10","chat CHAT-11","chat CHAT-12 (deleted)","chat CHAT-13","data dir: a copy, discarded after the run"]}
regression: [{"task":"TASK-2731","title":"Companion chat assistant: ask questions about tasks, meetings, runs and the vault, on a chosen Azure model"}]
---

# Test report — TASK-2751

Generated 2026-10-26T07:58:40.597Z.

## Unit and integration suite

2799 passed, 56 skipped, 0 failed (newest item session with a suite line).

## Tests added by this run

91 test case(s) added across the run's commits.

## Acceptance criteria

88/91 covered · 0 weak · 0 open · 3 waiting on a person.

## Smoke

6/6 passed on local (run-branch adapter (dist/companion-server.cjs) on port 0 over a copy of C:\dev\choda-deck\data — not the installed app, build 043d5ab, ran 2026-10-26T07:57:35.631Z).

| Check | Call | Expect | Got | Result |
|---|---|---|---|---|
| service is up under the adapter | GET /assistant/chats + process list | 200; assistant-server.cjs child of the adapter pid | status 200; 1 assistant-server.cjs child(ren) of pid 25768 | pass |
| old chats migrated | GET /assistant/chats vs shared assistant_chats | same ids, titles, tokensUsed; same message counts | 9 pre-release chats, 9 in assistant.db | pass |
| streaming + tools | POST /assistant/chats/:id/messages "what is the status of TASK-2751?" | text/event-stream, several deltas, get_task ok, reply names READY | text/event-stream; charset=utf-8; 136 deltas, first after 2033 ms; steps ["get_task"]; reply: **TASK-2751** is **READY** and marked **high priority**.  - **Assignee:** None - **Blocked by:** None - **Due date:** None - **Last updated:** October 26, 2026  | pass |
| general chat | POST messages "Dịch sang tiếng Anh: tôi đang bận" | an English translation, 0 steps, no refusal | steps 0; reply: I’m busy. | pass |
| chat actions | send, PATCH, regenerate, edit M1, DELETE on zz_test_TASK-2751_1 | each takes effect; deleted chat 404 after | rename 200; regen done; edit done; rows after edit 2; delete 204; get after 404 | pass |
| markdown | POST messages "a small TypeScript function in a code block" | reply holds a ``` fenced block (the web renders it with Copy) | fenced block: true; tokens 1224 | pass |

Test data created: "chat CHAT-10", "chat CHAT-11", "chat CHAT-12 (deleted)", "chat CHAT-13", "data dir: a copy, discarded after the run".

## Regression scope

- TASK-2731 — Companion chat assistant: ask questions about tasks, meetings, runs and the vault, on a chosen Azure model

## Items

| Task | AC covered | Tests added | Suite line |
|---|---|---|---|
| TASK-2753 Amend the model-call ADR for the separate assistant service | 6/6 | 0 | — |
| TASK-2754 Adapter: GET /vault/search for the assistant service | 6/6 | 6 | full suite: 2783 passed, 56 skipped, 0 failed |
| TASK-2755 Assistant service skeleton: own process, assistant.db, migration, chat routes incl. rename/delete/search | 14/14 | 14 | full suite: 2797 passed, 56 skipped, 0 failed |
| TASK-2756 Assistant service tools: read work data over the adapter's HTTP routes | 9/9 | 14 | full suite: 2811 passed, 56 skipped, 0 failed |
| TASK-2757 Assistant service streaming loop: send, regenerate, edit-and-resend as SSE, and the general-chat prompt | 13/13 | 14 | full suite: 2825 passed, 56 skipped, 0 failed |
| TASK-2758 Adapter spawns the assistant service and forwards /assistant/* (streamed), 503 + respawn once | 7/8 | 7 | full suite: 2832 passed, 56 skipped, 0 failed |
| TASK-2759 Remove the old in-adapter assistant code and stop creating its tables | 5/5 | 9 | full suite: 2799 passed, 56 skipped, 0 failed |
| TASK-2760 Companion Assistant view: streamed replies, markdown, code copy and Stop | 14/14 | 14 | full suite: 1228 passed, 0 skipped, 0 failed (web 1049 + electron 179) |
| TASK-2761 Companion vendor step ships assistant-server.cjs beside the adapter | 2/3 | 1 | full suite: 1229 passed, 0 skipped, 0 failed (web 1049 + electron/scripts 180) |
| TASK-2762 Companion Assistant view: rename, delete and search chats; regenerate and edit-and-resend | 12/13 | 12 | full suite: 1241 passed, 0 skipped, 0 failed (web 1061 + electron/scripts 180) |
