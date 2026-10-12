# TASK-2401 — AC verification

Snap the project list to a row boundary so no row is cut (option a). Butter picked (a) on 2026-10-12 after comparing side-by-side mockups of (a) and (b) on the live app.
Merged: companion PR #184 → `0849981` (ancestry proven against `origin/main`).

## Done — 4/4

| # | Criterion | Evidence |
|---|---|---|
| 1 | At 1280×800 at scroll top, no row or group header is partly visible | Playwright ×3: 12 items fully inside the 660px box, 6 fully below, 0 partial; the bar's top equals the box's bottom (724px). |
| 2 | Stubbed geometry: 8×100px rows, 500px area, 36px bar → box 404px, "4 more" | Component test asserts `style.height === "404px"` and the text "4 more"; an unsnapped box would read "3 more". |
| 3 | Next measure + evaluator note does not describe the list as cut off or clipped | `improve measure` 2026-10-12 on `0849981` (tests 1022/1022) + improve-evaluator: **4/5**. The note mentions only the unlabeled counts, the empty right pane and the lack of status. On 2026-10-11 it said "faded and clipped", then "cut off at the bottom". |
| 4 | TASK-2400 AC-4/5 and TASK-2376 AC-3 ticked; both DONE | Ticked in short sessions with the same evidence; both set DONE 2026-10-12. |

## Steps

1. Mockup: changed the live page in Playwright (snapped the box, moved the bar into flow) and showed Butter (a) and (b) side by side.
2. `snapHeight()` in `use-more-below.ts`: the bottom of the last row or group header that fits in `area − bar`, plus 4px. It works in content coordinates, so the height is stable while scrolling and independent of the height it sets. The list's container is observed for size changes.
3. `ProjectsView`: inline height on the list when it overflows; the bar sits in flow under it.
4. Gates: typecheck, lint, build exit 0; full web suite 868/868.

## Findings

- `/projects` LCP read 312 ms on 2026-10-12 against 172–176 ms the day before. That is still well inside the 1500 ms target. The snapping adds one re-render after the first measure; whether that explains it or it is noise will show in the next measures.
- The evaluator's remaining suggestion (label the per-row count, e.g. "2 workspaces") is not ticketed.
