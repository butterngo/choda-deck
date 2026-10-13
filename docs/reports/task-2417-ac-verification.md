# TASK-2417 — AC verification

**Task:** Decide screen: accept `[loop:<ws>]` notices and refuse converting them to tasks
**Parent:** TASK-2416 · **PR:** #352 · **Merge commit:** `f81585f` (ancestor of origin/main, proven)
**Run:** /choda-burn-backlog, label `autopilot`, 2026-10-12

## Done (5/5)

| # | Criterion | Evidence |
|---|---|---|
| 1 | `pendingSource('[loop:choda-deck] x')` → `{source:'loop', tag}`; `'[loopx:a] x'` → null | unit test AC-1 in `inbox-decide.test.ts`; the pre-change regex had no `loop` branch, so it would fail |
| 2 | `GET /inbox/pending` lists a raw loop item with `source: 'loop'` | handler test AC-2 (real HTTP + SQLite) |
| 3 | convert on a loop item → 400 naming the loop source, item stays raw | handler test AC-3: status 400, `source: 'loop'`, error contains `[loop:choda-deck]`, `getInbox().status === 'raw'` |
| 4 | archive with reason → 200, item archived | handler test AC-4 |
| 5 | `pnpm run lint` and `pnpm test` exit 0 | lint exit 0 locally; `build-and-test` green on ubuntu + windows in CI |

## Not done
None.

## Needs a human
None.

## Findings
- The first test run caught a real defect: the 400 error printed `undefined` for the tag, because `PendingItem` carries no `tag`. It was fixed before commit by reading the tag through `pendingSource(item.content)`.
- The local full suite had 3 failures, all in `workspace-diagram.test.ts` and `mermaid-check.test.ts`. They are the documented load-dependent mermaid flake (INBOX-2050) and pass 29/29 in isolation both with and without this change.
