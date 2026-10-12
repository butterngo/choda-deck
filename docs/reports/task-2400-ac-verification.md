# TASK-2400 — AC verification

Carry TASK-2376 AC-3: the evaluator still read the faded last project row as clipped. Butter chose option (b), an explicit "N more" control.
Merged: companion PR #183 → `8fdf6f2` (ancestry proven against `origin/main`).

## Done — 3/5

| # | Criterion | Evidence |
|---|---|---|
| 1 | Decide (a)/(b)/(c) with Butter | Butter chose **(b)** on 2026-10-11; recorded in the task Context. |
| 2 | `project-list-more` reads "N more", N = rows ending below the visible edge | Component test: 8×100px rows in a 500px box → exactly "3 more" (counting all rows would give 8, counting only fully hidden rows 2); 2 → gone → 3 as the list scrolls. Browser 1280×800 ×3: "4 more" equals the 4 rows measured below the edge. |
| 3 | Pressing it scrolls to the end, then it is absent | Playwright ×3: scrollTop 268 of max 268, button gone afterwards; plus a component test. |

## Not done — 2

| # | Criterion | Why |
|---|---|---|
| 4 | Evaluator note no longer mentions a clipped row | Official `improve measure` (tests 1022/1022) + improve-evaluator on `projects.png`: UI scannable **4/5**, note still says "the list is cut off at the bottom (partial MANTU header, '4 more')". A pre-merge check on the same layout scored 3.5 with no mention of clipping, so the evaluator is noisy here. Either way, the official note fails the criterion. |
| 5 | TASK-2376 AC-3 ticked, TASK-2376 DONE | Depends on #4. |

**Update 2026-10-12:** Butter chose (a) from a mockup; TASK-2401 (#184) snapped the list to a row boundary. The 2026-10-12 evaluator note has no cut-off wording (4/5), so AC-4/5 are ticked and the task is **DONE**. See task-2401-ac-verification.md.

## Findings

- What is left is a ~6px sliver of the next group header above the bar. Option (a), snapping the visible list height to a row boundary, is the only layout fix that removes it; (c) accepting the note is the other way out. That choice is Butter's.
- Evaluator scores for this page swing 3.5 ↔ 4 between near-identical screenshots, so a single note is weak evidence for a literal wording criterion like AC-4.
- New evaluator suggestions, not in scope: label the per-row workspace count ("2 workspaces"); there is no per-project status indicator.
