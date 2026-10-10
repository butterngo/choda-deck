# TASK-2353 — AC verification

Improve loop config schema + loader (`src/core/domain/improve/improve-config.ts`).
Merged in PR #330 (`be209f1`), proven an ancestor of `origin/main`.

## Done — 8/8

| # | Criterion | Evidence |
|---|---|---|
| 0 | Missing `.choda/improve.json` → `null` | unit test `returns null when the workspace has no .choda/improve.json` |
| 1 | `mode: "x"` → error naming `mode` | unit test asserts error fields `['mode']` exactly |
| 2 | 2 / 9 criteria → `criteria`; `measure: "foo"` → `criteria[i].measure` | unit tests assert the exact field lists |
| 3 | Defaults `sonnet` / `3` / `3`; `maxProposals: 6` → `maxProposals` | unit tests |
| 4 | save → load deep-equal | unit test (`toEqual`); an invalid save leaves the file's bytes unchanged |
| 5 | Companion fixture validates clean | `__fixtures__/companion-improve.json`, 5 criteria, mode manual |
| 6 | `pnpm test` exits 0 | 181 files / 2399 tests; CI green on PR #330 |
| 7 | `pnpm run lint` 0 errors | 1 pre-existing warning in `meeting-title.ts` |

## Not done / needs a human

None.

## Findings

- The first full `pnpm test` run failed on 3 timing-sensitive tests in untouched files
  (`mermaid-check` hook timeout, `workspace-diagram` timeout, `schema-version` WAL timing
  guard). All passed in isolation and on a full rerun — load-induced flakes, not regressions.
- Core cannot import the companion adapter's `atomic-file.ts`, so `saveImproveConfig` repeats
  its sibling-temp-file + rename pattern locally.
