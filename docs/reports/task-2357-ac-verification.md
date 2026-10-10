# TASK-2357 — AC verification

Improve loop companion routes (`src/adapters/companion/improve.ts`, wired in `http-server.ts`).
Tests: `src/adapters/companion/improve.test.ts` — real HTTP, a real SQLite service in a temp
dir, and a fake spawner (no test launches Claude).

## Done — 6/6

| # | Criterion | Evidence |
|---|---|---|
| 0 | `GET /improve/:ws` with no config → 200, `config: null`, `scorecards: []` | test `a workspace with no config → 200, config null, no scorecards` |
| 1 | `PUT …/config` invalid → 400 `{ error, field }`; valid → 200 + file on disk | tests assert `field: 'mode'` with no file written, then `mode: 'scheduled'` read back from disk and from GET |
| 2 | Screenshot traversal → 400; real PNG → 200 `image/png` | test requests `..%2F..%2F..%2Fsecret.png` (a real file exists there) → 400; `tasks-today.png` → 200 with the PNG bytes |
| 3 | Concurrent run same ws → 409; other ws → 202 `{ runId }` | test; also proves the slot frees when the run exits (`exitCode: 0`, `endedAt` set) |
| 4 | Reject → `rejected.json` gets `{ inboxId, reason, at }`; item leaves raw inbox | test reads `rejected.json` and `findInbox({ status: 'raw' })`; overview `proposals` is empty |
| 5 | Approve → task in the workspace's project; inbox `converted` | test reads the task (`projectId: 'p'`, title = first proposal line) and the inbox status |

## Not done / needs a human

None of the criteria. The default spawner (`spawnClaudeRun`) is not exercised by tests by
design; its first real use is the companion's "Run now" button once `/improve-loop` exists
(TASK-2358).

## Findings

- `inbox_convert` enforces the task-body template, so approving a free-text proposal threw.
  `proposalTaskBody` now builds Context / Acceptance / Test Plan / Related, carrying any
  `- [ ]` lines from the proposal into Acceptance. TASK-2358's skill should write its AC as
  checkboxes so they survive the conversion.
- An exception inside a handler left the request unanswered (the test hung). Handler errors
  now answer 422 (coded domain errors) or 500.
- Full `pnpm test` again hit the `mermaid-check` / `workspace-diagram` timing flakes on the
  first run; clean on rerun.
