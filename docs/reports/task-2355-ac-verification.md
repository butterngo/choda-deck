# TASK-2355 — AC verification

Companion Playwright harness + first e2e. Merged in choda-deck-companion PR #169 (`3e94f53`),
proven an ancestor of `origin/main`. The companion repo has no CI workflows.

## History

The first attempt stopped at research: the spec named a flow ("/tasks → Tạo task → Lưu") that
the companion does not have. It has no `/tasks` list, no `/tasks/today` and no create-task UI,
and the router's catch-all sends both paths to `/sync`. Butter approved retargeting to an
existing flow, **Search → open task**. TASK-2355, 2356 and 2362 were updated before the session
started.

## Done — 4/4

| # | Criterion | Evidence |
|---|---|---|
| 0 | `pnpm e2e` exits 0 on Windows, runs `e2e/search-to-task.spec.ts` | 1 passed |
| 1 | A wrong expected title makes `pnpm e2e` exit non-zero | title swapped → exit 1 (`toBeVisible() failed`); restored → exit 0 |
| 2 | `pnpm test` runs nothing under `e2e/` | `vitest list --filesOnly`: 91 files, 0 e2e; without the new exclude it lists 1 |
| 3 | JSON report at `packages/web/e2e-results/report.json` with status + annotations | status `passed`, `duration-ms` 985, `steps` 4 |

## Findings

- **Hash router.** Companion routes are `#/…`, so page URLs need the hash (`/#/projects`).
  This matters for every improve config: `pages` must be `/#/sync`, `/#/projects`, `/#/activity`,
  and TASK-2356's fixture update has to use them.
- **A search hit opens the graph** (`#/graph?project=…&node=…`), not the task page. The spec
  confirms the hit and then opens `#/tasks/:id` directly. The AC wording does not pin the click
  target, so no criterion was redefined.
- **Playwright 1.64 needs `chromium-headless-shell-1248`.** It was downloaded once with
  `pnpm exec playwright install chromium`. TASK-2356's CLI needs the same browser.
- **Pre-existing lint failure** in the companion: `packages/web/src/views/MeetingSave.tsx:120`
  (`no-useless-escape`). The file is untouched and has been on `main` since #152, while the new
  files lint clean. It needs its own small fix.
