# TASK-2359 — AC verification

Improve tab in the companion's WorkspaceView, over `GET /improve/:ws` (TASK-2357). Merged in
choda-deck-companion PR #170 (`ff06aa7`), proven an ancestor of `origin/main`. The companion
repo has no CI workflows.

## Done — 5/6

| # | Criterion | Evidence |
|---|---|---|
| 0 | Approve calls `POST /improve/:ws/proposals/:id/approve` | `improve-tab.test.tsx` reads the request the stubbed fetch received: `POST /api/improve/choda-deck-companion/proposals/INBOX-9001/approve` |
| 1 | Reject with a typed reason calls `…/reject` with `{ reason }` | Save is disabled with no reason; with one, the request equals `{ POST, …/reject, { reason } }`, trimmed |
| 2 | Off/Manual/Scheduled calls `PUT /improve/:ws/config` with the new `mode` | body is the full config with `mode: "scheduled"`; a control test clicks the selected mode and sees no request |
| 3 | `config: null` → "Chưa bật improve loop" empty state with a Settings button | asserted on `empty-state` + `improve-open-settings`; a separate test shows an invalid config names its field instead of claiming "not enabled" |
| 4 | `/workspaces/<id>?tab=improve` lands on the Improve tab | `workspace-view.test.tsx`: improve pane rendered, tab `aria-selected`, docs pane absent |

The tests stub `fetch`, not the hooks, so the real `useImprove` + react-query path runs.

## Needs a human — 1

**AC-5, at 390px the blocks stack and the scorecard table scrolls horizontally.** It is built
for it: every block is one column under `md`, and the table sits in its own
`overflow-x-auto` box (`improve-scorecard-scroll`) with `whitespace-nowrap` cells. jsdom has no
layout, so only a look at the real page settles it.

## Blocker for a live look

The running companion adapter (started 2026-10-08) predates the improve routes and answers
404 for `/improve/*`. `dist/companion-server.cjs` on disk has them. The service needs a
restart before the tab shows anything but an error. It is Butter's service, so the runner did
not restart it.

## Findings

- **`Trend` is shared now.** It moved from `ActivityView` to `components/Trend.tsx` with an
  optional `markers` prop (dashed lines). Activity's DOM and its 4 tests are unchanged.
- **Ship days are inferred.** The scorecard has no "shipped" field, so the trend marks days
  whose `commit` differs from the day before.
- **Settings is a placeholder.** The button opens a note pointing at `.choda/improve.json`;
  TASK-2360 puts the form there.
- **Every write sends the whole config.** `PUT /config` validates a complete file, so the
  mode switch and the "good enough" tick both send the full config back.
- Full suite: 91/92 files; `DocDiagrams.test.tsx` failed 2 tests (one at 41 s) and passes
  12/12 alone. It is the companion's known intermittent pair, in a file this change does not
  touch.
