# TASK-2152 — AC verification

**Task:** Companion adapter: GET /activity/digests serves stored daily digests
**Verified on:** `main` @ `8f931d4` (PR #315, squash-merged, ancestry proven, CI 3/3 green)
**Session:** SESSION-1790418075158-27 · **Date:** 2026-09-26
**Result:** 6/6 AC ticked · 0 need a human · 0 blockers

## Done

| AC | Surface | Evidence |
|---|---|---|
| AC-1 | HTTP via `startCompanionServer`, test `AC-1:` | 200. Dates are `["2026-09-24","2026-09-25"]` in order, and a stored out-of-range 09-26 file is excluded. |
| AC-2 | same, test `AC-2:` | Length 1 for a 3-day range with 1 file. Null-filling would give 3. |
| AC-3 | same, test `AC-3:` | 400 with a non-empty `error` |
| AC-4 | same, test `AC-4:` | 400 for from > to |
| AC-5 | same, test `AC-5:` | 200 `[]` with no activity dir |
| AC-6 | `grep -c "\.claude" src/adapters/companion/activity.ts` | 0. Also pinned by test `AC-6:`. |

## Live check on the shipped artifact

`dist/companion-server.cjs` was built from main and started with `CHODA_COMPANION_PORT=7391` and `CHODA_DATA_DIR` pointed at a temp dir. The temp dir held a real 2026-09-25 digest produced by `dist/cli.cjs activity digest` against a copy of the real DB.

- `GET /activity/digests?from=2026-09-24&to=2026-09-26` → **200**, `[2026-09-25: 111 prompts]`
- `GET /activity/digests?from=2026-13-01` → **400** `{"error":"\"from\" must be a YYYY-MM-DD date (got \"2026-13-01\")"}`

The server was stopped by the PID that owned port 7391. The user's running `ChodaCompanionServer` (port 7338) was not touched, and it keeps serving the old code until its next restart.

## Findings

- **Not token-gated, deliberately.** This matches the other read routes (`/tasks`, `/conversations`): the adapter sends no CORS headers, so a cross-origin page cannot read the response. Note that `metrics.repeatedPrompts` does carry normalized prompt text. If that ever needs stronger protection, it belongs behind the same gate as `/artifacts`.
- **Load flake variant.** In one full-suite run, `workspace-diagram.test.ts` failed 3 tests, one of them as `expected 502 to be 200` rather than a timeout. On this branch the file then passed 29/29 alone, three runs in a row. The new route matches only `/activity/digests`, so it cannot reach `/workspace-docs/diagram`. This is the known mermaid load stall (INBOX-2050/2060). The 502 shape is new and worth adding to that item.
- **Bundle size** grew by about 3 KB (recorded in `docs/adapter-bundle-size.md` in the same PR).

## Needs a human

None.
