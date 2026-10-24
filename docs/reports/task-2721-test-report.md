---
goal: "TASK-2721"
generatedAt: "2026-10-24T05:01:51.452Z"
suite: {"passed":2728,"skipped":56,"failed":0}
testsAdded: 14
unreadableCommits: []
ac: {"covered":10,"weak":0,"open":0,"human":1,"total":11}
smoke: {"env":"local","base":"node C:\\dev\\choda-deck.worktrees\\autopilot-TASK-2721\\scripts\\hooks\\file-edit-event.mjs (stdin = PostToolUse JSON)","build":"c36aeaa","ranAt":"2026-10-24T05:01:20.777Z","checks":[{"name":"hook self-test","call":"node scripts/hooks/file-edit-event.mjs --self-test","expect":"exit 0","got":"exit 0: [self-test] OK — 5 file_modified events + 1 gotcha_surfaced (once per session)","ok":true},{"name":"worktree edit surfaces a real gotcha","call":"stdin Edit C:\\dev\\choda-deck.worktrees\\autopilot-TASK-2721\\src\\adapters\\companion\\http-server.ts","expect":"stdout one JSON line; additionalContext contains a-new-adapter-route-is-invisible-to-the-shipped-companion-and-the-only-signal-is","got":"exit 0, 1 line(s): Gotchas guarding src/adapters/companion/http-server.ts — read before continuing: | - A new adapter route is invisible to the shipped companion — and the only signal is the 404 body (knowledge_get \"a-new-adapter-route-is-invisible-to-the-shipped-companion-and-the-only-signal-is\") | - Companion adapter mutations go only through the writable service, only via workflow.ts routes (knowledge_get \"companion-mutations-only-writable-svc-only-workflow-routes\")","ok":true},{"name":"once per session","call":"repeat: stdin Edit C:\\dev\\choda-deck.worktrees\\autopilot-TASK-2721\\src\\adapters\\companion\\http-server.ts","expect":"stdout empty","got":"exit 0, stdout \"\"","ok":true},{"name":"evaluation trail","call":"session_events of SESSION-1792818055625-42 (= session_event_list)","expect":"exactly one gotcha_surfaced row for a-new-adapter-route-is-invisible-to-the-shipped-companion-and-the-only-signal-is","got":"1 row(s) for slug; all surfaced: [{\"kind\":\"gotcha_surfaced\",\"slug\":\"a-new-adapter-route-is-invisible-to-the-shipped-companion-and-the-only-signal-is\",\"path\":\"src/adapters/companion/http-server.ts\"},{\"kind\":\"gotcha_surfaced\",\"slug\":\"companion-mutations-only-writable-svc-only-workflow-routes\",\"path\":\"src/adapters/companion/http-server.ts\"}]","ok":true}],"data":[{"smokeSession":"SESSION-1792818055625-42"}]}
regression: [{"task":"TASK-988","title":"Add real schema types for feature / code_ref / gotcha + TOUCHES edge with relation (ADR-NNN unified knowledge graph)"},{"task":"TASK-992","title":"P3-EDGES: Add REALIZES, ABOUT, PINS, IN, INTEGRATES_WITH edges"},{"task":"TASK-993","title":"P6-INBOX: Make inbox.workspaceId nullable + progressive localization"},{"task":"TASK-998","title":"GOTCHA-AUTO: Agent auto-proposes structured gotchas at session_end"},{"task":"TASK-999","title":"ADR-META: Freeze ADR-NNN §6 open questions + confirm next ADR number"}]
---

# Test report — TASK-2721

Generated 2026-10-24T05:01:51.452Z.

## Unit and integration suite

2728 passed, 56 skipped, 0 failed (newest item session with a suite line).

## Tests added by this run

14 test case(s) added across the run's commits.

## Acceptance criteria

10/11 covered · 0 weak · 0 open · 1 waiting on a person.

## Smoke

4/4 passed on local (node C:\dev\choda-deck.worktrees\autopilot-TASK-2721\scripts\hooks\file-edit-event.mjs (stdin = PostToolUse JSON), build c36aeaa, ran 2026-10-24T05:01:20.777Z).

| Check | Call | Expect | Got | Result |
|---|---|---|---|---|
| hook self-test | node scripts/hooks/file-edit-event.mjs --self-test | exit 0 | exit 0: [self-test] OK — 5 file_modified events + 1 gotcha_surfaced (once per session) | pass |
| worktree edit surfaces a real gotcha | stdin Edit C:\dev\choda-deck.worktrees\autopilot-TASK-2721\src\adapters\companion\http-server.ts | stdout one JSON line; additionalContext contains a-new-adapter-route-is-invisible-to-the-shipped-companion-and-the-only-signal-is | exit 0, 1 line(s): Gotchas guarding src/adapters/companion/http-server.ts — read before continuing: \| - A new adapter route is invisible to the shipped companion — and the only signal is the 404 body (knowledge_get "a-new-adapter-route-is-invisible-to-the-shipped-companion-and-the-only-signal-is") \| - Companion adapter mutations go only through the writable service, only via workflow.ts routes (knowledge_get "companion-mutations-only-writable-svc-only-workflow-routes") | pass |
| once per session | repeat: stdin Edit C:\dev\choda-deck.worktrees\autopilot-TASK-2721\src\adapters\companion\http-server.ts | stdout empty | exit 0, stdout "" | pass |
| evaluation trail | session_events of SESSION-1792818055625-42 (= session_event_list) | exactly one gotcha_surfaced row for a-new-adapter-route-is-invisible-to-the-shipped-companion-and-the-only-signal-is | 1 row(s) for slug; all surfaced: [{"kind":"gotcha_surfaced","slug":"a-new-adapter-route-is-invisible-to-the-shipped-companion-and-the-only-signal-is","path":"src/adapters/companion/http-server.ts"},{"kind":"gotcha_surfaced","slug":"companion-mutations-only-writable-svc-only-workflow-routes","path":"src/adapters/companion/http-server.ts"}] | pass |

Test data created: {"smokeSession":"SESSION-1792818055625-42"}.

## Regression scope

- TASK-988 — Add real schema types for feature / code_ref / gotcha + TOUCHES edge with relation (ADR-NNN unified knowledge graph)
- TASK-992 — P3-EDGES: Add REALIZES, ABOUT, PINS, IN, INTEGRATES_WITH edges
- TASK-993 — P6-INBOX: Make inbox.workspaceId nullable + progressive localization
- TASK-998 — GOTCHA-AUTO: Agent auto-proposes structured gotchas at session_end
- TASK-999 — ADR-META: Freeze ADR-NNN §6 open questions + confirm next ADR number

## Items

| Task | AC covered | Tests added | Suite line |
|---|---|---|---|
| TASK-2722 The edit hook surfaces the gotchas whose refs name the file just edited, including in autopilot worktrees | 10/11 | 14 | full suite: 2728 passed, 56 skipped, 0 failed |
