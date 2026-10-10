# TASK-2354 — AC verification

Evaluator subagent at `~/.claude/agents/improve-evaluator.md` (outside git, TASK-2352 Q3).
It sees only screenshots, the `by: agent` criteria and the `rejected` list, and returns a
fixed JSON array.

## Done — 1/4

| # | Criterion | Evidence |
|---|---|---|
| 0 | Frontmatter `model: sonnet`, `tools: Read` only | `tools: Read` and `model: sonnet` are the only tool/model lines; no Bash, Edit or Write in the frontmatter |

## Needs a human — 3

These were classified human-class at planning ("needs a Claude run"). The runner did the
runs and records the output here; it does not tick them. Butter's read of the evidence is
the verdict.

**How the runs were made.** A new agent file is only registered when a session starts, so
each run was a sonnet subagent told to read the agent file and act as it, with Read only.
Input, identical for all 3 runs:

- criteria: `UI scannable` (the companion fixture's own measure) and
  `Navigation self-explanatory` ("A first-time user can tell what each sidebar item leads to
  without hovering or clicking").
- screenshots: `2026-10-10/projects.png` and `2026-10-10/sync.png` from the TASK-2356 run.
- rejected: "Add text labels next to the sidebar icons" and "Auto-select the first project so
  the right pane is never empty". Both are the obvious fix for what the screenshots show, so
  the list is a real test, not a decoy.

| # | Criterion | Observed |
|---|---|---|
| 1 | Output is a JSON array, one `{criterion, score, evidence}` per criterion, scores 1–5 at 0.5 steps | All 3 runs: valid JSON, 2 objects in input order, scores 3.5 and 2 |
| 2 | 3 reruns: score spread ≤0.5 per criterion | `UI scannable` 3.5 / 3.5 / 3.5; `Navigation` 2 / 2 / 2 — spread 0 |
| 3 | No `suggestion` repeats a rejected idea | No run suggested per-icon labels or auto-selecting a project. Run 1 gave no navigation suggestion. Runs 2 and 3 suggested **group headings over the icon clusters** ("Work", "Knowledge", "System"). That is near the rejected idea but not the same one — Butter to judge |

Suggestions for `UI scannable` differed between runs (collapse repeated DRAIN rows; label the
count column; replace the count with a status badge). The scores did not.

## Findings

- **Evidence is specific.** Every run named the region ("left sidebar x≈28", "right-aligned
  counts", "last row clipped at the bottom"), as the prompt requires.
- **Suggestion variety is not score noise.** Three runs found three different fixes for the
  same 3.5. `/improve-loop` (TASK-2358) should take suggestions from one run, not merge runs.
- **Rejected matching is semantic and loose.** If group headings should count as a repeat of
  "labels next to icons", the `rejected` wording has to be broader, or the agent needs a rule
  like "nothing that adds text to the sidebar".
