# TASK-2402 — AC verification

Label the workspace and project counts on the Projects screen. Butter approved it on 2026-10-12.
Merged: companion PR #185 → `d318a15` (ancestry proven against `origin/main`).

## Done — 3/3

| # | Criterion | Evidence |
|---|---|---|
| 1 | Rows read "N workspaces" / "1 workspace", live only | Component test: choda-deck (3 registered, 1 archived) shows exactly "2 workspaces" (counting archived would give 3); english-companion shows "1 workspace". Live screen: "Automation Rule … 2 workspaces", "Ichiba DevOps … 1 workspace". |
| 2 | Group headers read "N projects" / "1 project" | Component test: `group-count-ichiba` = "2 projects", `group-count-personal` = "1 project". Live screen: "ICHIBA 9 projects", "JSP 1 project". |
| 3 | Evaluator note no longer calls the counts unlabeled | `improve measure` 2026-10-12 on `d318a15` (tests 1024/1024) + improve-evaluator: 4/5; the note says the counts are "all readable without hover". The previous note said "Counts are unlabeled". |

## Steps

1. Added the `countLabel(n, noun)` helper in `ProjectsView.tsx`; the row count uses `flex-none`.
2. The first test id `project-group-count-*` collided with an existing `[data-testid^='project-group-']` selector (one failure in the TASK-2200 ordering test). Renamed it to `group-count-*`.
3. Gates: typecheck, lint, build exit 0; full web suite 870/870. Browser 1280×800: no project name wraps.

## Findings

- `/projects` LCP has risen across today's measures: 172–176 ms (2026-10-11), 312 ms (after TASK-2401), 380 ms (after this task). It is still far inside the 1500 ms target, but the trend began with the row-boundary snap (an extra measure + re-render after mount). Worth checking whether it is noise before it grows.
- Evaluator's next suggestion: make the group headers slightly bolder or larger.
