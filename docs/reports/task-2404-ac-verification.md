# TASK-2404 — AC verification

English UI copy for the Decide screen, its nav entry and the daily reminder. Butter asked for it on 2026-10-12.
Merged: companion PR #186 → `c4757ae` (ancestry proven against `origin/main`).

## Done — 3/3

| # | Criterion | Evidence |
|---|---|---|
| 1 | No Vietnamese in the UI strings of the four files | A grep for Vietnamese letters in `DecideView.tsx`, `SidebarNav.tsx`, `LandingRedirect.tsx` and `electron/attention-reminder.cjs` finds only the line-1 code comment that quotes the old name. |
| 2 | h1 "Needs your decision"; the sidebar entry reads the same | `decide-route.test.tsx` finds the h1 by exact name in 2 cases. The sidebar label and icon title come from the source; no component test asserts the label itself. |
| 3 | Reminder body is pluralised in English | `attention-reminder.test.cjs`: "3 items waiting on your decision (1 from the daily digest)" and "1 item waiting on your decision". |

## Steps

String-for-string replacement with no reformat. A first pass ran prettier over `DecideView.tsx` and rewrote 110 lines, so it was reverted and redone as a 42/42-line diff. Gates: typecheck, lint, build exit 0; web 870/870, electron 154/154.

## Findings

- `ImproveTab.tsx` still uses "Duyệt → task", and the Improve, meeting and week-compare screens are still in Vietnamese. They were out of scope here.
- The packaged app only shows the new copy after a companion release (next after 0.19.0).
