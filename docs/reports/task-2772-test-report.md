---
goal: "TASK-2772"
generatedAt: "2026-10-27T05:30:01.757Z"
suite: {"passed":1253,"skipped":0,"failed":0}
testsAdded: 14
unreadableCommits: ["2d30586"]
ac: {"covered":23,"weak":0,"open":0,"human":2,"total":25}
smoke: {"env":"local","base":"run-branch adapter (dist/companion-server.cjs) on port 0 over a copy of C:\\dev\\choda-deck\\data, and the run branch's built web CSS — not the installed app","build":"choda-deck dcd4283, companion 3544c2c","ranAt":"2026-10-27T05:29:50.077Z","checks":[{"name":"dark dropdown (built CSS)","call":"grep packages/web/dist/assets/*.css","expect":".dark color-scheme:dark, :root color-scheme:light, .dark option colours","got":"dark true, light true, option true — the popup itself is TASK-2773 AC-6 (human)","ok":true},{"name":"per-repo suite","call":"GET /runs → TASK-2772 report.summary.suites","expect":"entries for choda-deck-companion and main with their own counts","got":"status 200; suites [\"choda-deck-companion:1253\",\"main:2805\"]","ok":true},{"name":"mermaid reply","call":"POST /assistant/chats/:id/messages \"Draw a mermaid sequence diagram of a login…\" on zz_test_TASK-2772_1","expect":"the reply holds a ```mermaid fence that parses (what MermaidBlock draws)","got":"CHAT-12; fence present; mermaid check exit 0: ok: 1 fence(s)","ok":true}],"data":["CHAT-12 (zz_test_TASK-2772_1, deleted after the check)","data dir copy, discarded after the run"]}
regression: [{"task":"TASK-807","title":"Epic: Migrate companion web SPA from vanilla JS → React for mobile parity"},{"task":"TASK-830","title":"Epic: Migrate mobile to consume packages/shared/ (types + api + SSE) for web ⇄ mobile parity"}]
suites: [{"workspaceId":"choda-deck-companion","passed":1253,"skipped":0,"failed":0},{"workspaceId":"main","passed":2805,"skipped":56,"failed":0}]
---

# Test report — TASK-2772

Generated 2026-10-27T05:30:01.757Z.

## Unit and integration suite

1253 passed, 0 skipped, 0 failed (newest item session with a suite line).

| Workspace | Passed | Skipped | Failed |
|---|---|---|---|
| choda-deck-companion | 1253 | 0 | 0 |
| main | 2805 | 56 | 0 |

## Tests added by this run

14 test case(s) added across the run's commits.

Commits not readable here: 2d30586.

## Acceptance criteria

23/25 covered · 0 weak · 0 open · 2 waiting on a person.

## Smoke

3/3 passed on local (run-branch adapter (dist/companion-server.cjs) on port 0 over a copy of C:\dev\choda-deck\data, and the run branch's built web CSS — not the installed app, build choda-deck dcd4283, companion 3544c2c, ran 2026-10-27T05:29:50.077Z).

| Check | Call | Expect | Got | Result |
|---|---|---|---|---|
| dark dropdown (built CSS) | grep packages/web/dist/assets/*.css | .dark color-scheme:dark, :root color-scheme:light, .dark option colours | dark true, light true, option true — the popup itself is TASK-2773 AC-6 (human) | pass |
| per-repo suite | GET /runs → TASK-2772 report.summary.suites | entries for choda-deck-companion and main with their own counts | status 200; suites ["choda-deck-companion:1253","main:2805"] | pass |
| mermaid reply | POST /assistant/chats/:id/messages "Draw a mermaid sequence diagram of a login…" on zz_test_TASK-2772_1 | the reply holds a ```mermaid fence that parses (what MermaidBlock draws) | CHAT-12; fence present; mermaid check exit 0: ok: 1 fence(s) | pass |

Test data created: "CHAT-12 (zz_test_TASK-2772_1, deleted after the check)", "data dir copy, discarded after the run".

## Regression scope

- TASK-807 — Epic: Migrate companion web SPA from vanilla JS → React for mobile parity
- TASK-830 — Epic: Migrate mobile to consume packages/shared/ (types + api + SSE) for web ⇄ mobile parity

## Items

| Task | AC covered | Tests added | Suite line |
|---|---|---|---|
| TASK-2637 Test report: show the unit + integration suite per workspace, not only the newest session's line | 10/10 | 5 | full suite: 2805 passed, 56 skipped, 0 failed |
| TASK-2773 Companion dark mode: native controls (select popups) follow the theme | 5/6 | 3 | full suite: 1247 passed, 0 skipped, 0 failed |
| TASK-2774 Companion Assistant: draw mermaid fences in finished replies as diagrams | 8/9 | 6 | full suite: 1253 passed, 0 skipped, 0 failed |
