# TASK-2399 — AC verification

Console errors went from 0 to 2 on every companion page in the improve measure.
Merged: choda-deck PR #348 → `d19abe9` (ancestry proven against `origin/main`; CI green).

## Done — 3/3

| # | Criterion | Evidence |
|---|---|---|
| 1 | The cause, named with the real console text | Playwright on the Vite dev server, which is how the measure serves the app. On /#/sync, /#/projects and /#/activity: two `Failed to load resource: the server responded with a status of 401 (Unauthorized)` for `/api/inbox/pending`, the sidebar badge's poll (0.19.0). The route is bridge-token gated. The packaged app's static proxy adds the token; the dev proxy only adds it when `CHODA_BRIDGE_TOKEN(_FILE)` is set, and the measure set neither. With the token, the same route answers 200. |
| 2 | Next measure: 0 console errors on all three pages | `improve measure` 2026-10-12 with the rebuilt CLI: consoleErrors 0 / 0 / 0 (was 2 each); criterion value 0. |

| 3 | In the packaged app the Decide badge still shows the pending count | Butter confirmed it on packaged 0.19.1 on 2026-10-12, with temporary item INBOX-2206 pending (archived afterwards). |

## Fix

`bridgeTokenEnv(dataDir, env)` in `src/adapters/cli/improve-command.ts` sets `CHODA_BRIDGE_TOKEN_FILE=<dataDir>/bridge-token.txt` for the app the measure starts. It does so only when the file exists and the caller set neither variable, and it passes the path only, never the token value. Unit tests cover the file present, the file absent, and a caller-set token. Gates: typecheck, lint, build exit 0. Full suite: the only failures are the documented `mermaid-check` / `workspace-diagram` flakes.

## Findings

- Rejected alternative: un-gating `GET /inbox/pending` in the adapter. Every other companion read with private content (improve, meetings, docs) is gated too, and the measure should behave like the product, not the other way round.
- In the same measure, `/projects` LCP was 260 ms (down from 380 ms earlier today), which supports the earlier rise being noise.
