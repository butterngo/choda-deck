# TASK-2376 — AC verification

Stop the last project row from being clipped in the list (improve-loop proposal INBOX-2200, workspace choda-deck-companion).
Merged: companion PR #182 → `6a9760c` (ancestry proven against `origin/main`).

## AC revised before work (with Butter)

The original AC-1 asked for the last row to be fully visible in the measure's screenshot. The project list is a scroll container (`overflow-y-auto`) taller than the 800px viewport, so the "clipped" row is the viewport edge at scroll top, not a CSS bug. The real defects were that nothing showed the list continues and that the end of the list had no bottom padding. Shrinking rows to fit today's 12 projects was rejected as gaming the screenshot. Butter picked the revised AC on 2026-10-11.

## Done — 2/3

| # | Criterion | Evidence |
|---|---|---|
| 1 | Scrolled to the end at 1280×800, the last row sits ≥ 12px above the list edge | Playwright on `6a9760c`: `project-row-micro-k8s` is 17px above the `project-list` bottom; 5/5 identical runs on the branch. |
| 2 | `project-list-more` fade is visible at scroll top and absent at the end | Playwright: visible at top (scrollHeight 984 > clientHeight 716), absent at the end. Component tests cover top / end / back up, a list that fits, and a list that mounts after the adapter turns healthy. |

## Not done — 1

| # | Criterion | Why |
|---|---|---|
| 3 | UI scannable evaluator note no longer mentions a clipped row | The re-measure plus improve-evaluator on the new `projects.png` scored **4/5** (from 3.5, target met), but the note still says "The bottom MANTU row is faded and clipped." The evaluator judges one still frame at scroll top, so a scroll container always shows a row at its edge. Carried to **TASK-2400** for a product call. |

**Update 2026-10-12:** after TASK-2400 ("N more" bar, #183) and TASK-2401 (row-boundary snap, #184), the 2026-10-12 evaluator note has no clipped wording (4/5). AC-3 ticked; the task is **DONE**. See task-2401-ac-verification.md.

## Steps

1. Read the screenshot and `ProjectsView.tsx` → found the list is a scroll container, not a CSS clip. Stopped and asked Butter (contract gap), revised the AC, restarted the session.
2. Built the `useMoreBelow` hook and the fade + `pb-4` in the view; added component tests.
3. Browser check exposed a race: on most loads the first version (a `useRef` read in an effect) measured a null ref, because the list mounts after health turns connected while the projects are already cached. Switched to a callback ref plus a ResizeObserver; the browser check then passed 5/5. Added a component test for the late mount; it fails on the `useRef` variant and passes on the fix.
4. Gates: typecheck, lint, build exit 0; full web suite 866/866.
5. Merged #182; ran `improve measure` (tests 1020/1020) and the improve-evaluator on the new screenshot.

## Findings

- The evaluator's new suggestion: the per-row workspace count is an unlabeled gray number; label it ("2 ws") or render it as a pill. Recorded in TASK-2400.
- An earlier full-suite `exit 1` and a "699 failed" run were both vitest started from the repo root (no web config, no jsdom) when parallel shell calls shared a cwd. Rerun alone from `packages/web`: 866/866, exit 0.
- Console errors are still 2 per page; tracked in TASK-2399.
