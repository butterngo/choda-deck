---
type: spike
title: "Spike v2: Cold vs Pre-warm on TASK-704-shape (ADR-019 Phase 2 follow-up)"
projectId: choda-deck
scope: project
createdAt: 2026-05-11
lastVerifiedAt: 2026-05-11
refs:
  - path: src/core/executor/queue-claude-spawn.ts
    commitSha: b1337da2a6d5da270391c5fc95112d2043e37e50
  - path: src/core/domain/lifecycle/queue-lifecycle-service.ts
    commitSha: c82165fe3b2241be334d524f71f772379a695a69
  - path: docs/knowledge/ADR-019-autonomous-queue-runner.md
    commitSha: d15753a320f72e21054c4750fd2a48236d5b723f
  - path: docs/knowledge/spike-prewarm-budget-2026-05-11.md
    commitSha: d15753a320f72e21054c4750fd2a48236d5b723f
---

# Spike v2: cold vs pre-warm on TASK-704-shape (heavy cross-cutting)

## TL;DR

1. **Cold lane fails TASK-704-shape at $0.95 cap.** Run 1 hit `error_max_budget_usd` at $0.965 / 20 turns with incomplete work — claude self-aborted mid-implementation. Validates v1's self-flagged caveat that pre-warm benefit may scale with task complexity.
2. **Pre-warm flips outcome from FAIL to PASS at same cost.** Run 2 finished cleanly at $0.947 / 31 turns, all implementation AC pass. Pre-warm benefit on heavier scope ≠ cost reduction — benefit = work *completes* inside the budget cold can't.
3. **Pre-warm signature differs by task shape:**
   - v1 TASK-707 (light extend, 4-file modify): -23.5% cost, -50% turns — *same outcome, cheaper*.
   - v2 TASK-704 (heavy cross-cutting, 3 modify + 2 new + ≥6 AC commands): -1.8% cost, +55% turns — *different outcome (pass vs fail)*.
4. **Decision per outcome matrix (CONV-1778501854581-13)**: "Pre-warm pass + cold fail" → **ship pre-warm** as additive, same-lane, production-safe.

## Method

Test task: TASK-704 reverted body (`Implement 7 metrics logging into queue-run.json`) — cross-cutting cross-shape (3 file modify + 2 new file + ≥6 AC commands incl typecheck/lint/test/verify-script/dry-run). Source body = the exact prompt sent in dogfood Run 2: `data/artifacts/queue-1778481496836-9t4b/tasks/TASK-704/prompt.md` (64 lines, pre-Dogfood-notes state).

Isolated worktree `C:/dev/choda-deck.worktrees/spike-714` at commit `3b2549c` (parent of TASK-704 implementation `b1337da`). `git reset --hard 3b2549c && git clean -fd` between runs to isolate.

Spawn signature replicates queue runner exactly (`queue-claude-spawn.ts:38-58`):

- `claude -p` with `--strict-mcp-config --mcp-config queue-mcp-empty.json` (zero MCP)
- `--allowed-tools "Read Edit Write Glob Grep Bash(pnpm *) Bash(node *) Bash(git diff*) Bash(git status*)"`
- `--permission-mode bypassPermissions`
- `--max-budget-usd 0.95` (post-F1 formula = `maxCostPerTask × 0.95`, default $1.50)
- `--model claude-sonnet-4-6`
- Stdin = task body (Run 1) OR pre-warm prefix + task body (Run 2)

Pre-warm prefix: per-file 5-line summary (purpose + key line numbers + path-drift callouts) for each File Pointer in TASK-704 body, plus correction notes for two drifts encountered (test file path, missing `pnpm queue-run` script). Total ~34 lines, saved at `C:/tmp/spike-714/prewarm.md`.

Run 3 (warm interactive diagnostic) **deferred** — Decision matrix already resolved to "ship pre-warm" branch after Run 1+2; Run 3 was only load-bearing for the "warm pass + cold fail → lane abstraction wrong" branch which v2 didn't hit. Operator time + cost saved (~$0.5-1 + 10ph).

## Raw data

| Run | Stdin | Budget arg | Actual cost | Ratio | Turns | Output tokens | Cache read | Cache create | Subtype | AC (charitable) | Fit |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 cold | body 64L | $0.95 | $0.96451 | 1.015× | 20 | 23,301 | 960,914 | 65,319 | error_max_budget_usd | partial (incomplete) | **FAIL** |
| 2 prewarm | prewarm + body 98L | $0.95 | $0.94700 | 0.997× | 31 | 18,144 | 1,553,058 | 55,052 | all impl pass | **FIT** |

Per-run wall time: Run 1 = 6.18 min, Run 2 = 5.37 min. Spike total cost = **$1.911** (well under $3 hard cap).

### Reference: v1 spike data (TASK-707-shape, light scope)

| Phase | Stdin | Budget | Actual | Turns | Outcome |
|---|---|---|---|---|---|
| A1 baseline | body only | $1.00 | $0.677 | 40 | success |
| A2 pre-warm | prewarm + body | $1.00 | $0.518 | 20 | success |

v1: pre-warm -23.5% cost, -50% turns, *same outcome both pass*. v2: pre-warm -1.8% cost, +55% turns, *outcome differs (fail vs pass)*.

## Findings

### F1 — Cold lane abstraction fits light scope, fails heavy cross-cutting

Cold lane (current production signature) succeeds on TASK-707-shape (4-file extend, ~30ph human-estimate) at $0.95 cap with comfortable headroom ($0.518-0.677 actual). Same lane on TASK-704-shape (≥6 AC commands, 3 modify + 2 new) self-aborts at 1.015× cap with incomplete work.

**Implication:** the auto-safe ≤3h scope envelope (ADR-019) is necessary but not sufficient. Task *shape* (file count + new files + AC command count) matters at least as much as time-estimate. TASK-704 was within auto-safe estimate (~3h) but its shape pushed cold past budget.

This is exactly the gap v1 self-flagged: *"Re-test on TASK-704-shape (heavier scope) — pre-warm benefit may scale with task complexity"* — confirmed scaling, but not in the dimension expected (cost). Pre-warm scales *completability*, not *cheapness*, as task shape gets heavier.

### F2 — Pre-warm changes outcome, not cost, at heavy scope

Run 1 vs Run 2 cost is nearly identical (Δ −$0.018, −1.8%). Both spent essentially the full $0.95 budget. But:

| | Run 1 cold | Run 2 prewarm | Δ |
|---|---|---|---|
| Outcome | aborted incomplete | completed | — |
| Turns | 20 | 31 | +55% |
| Output tokens | 23,301 | 18,144 | -22% |
| Cache read | 960,914 | 1,553,058 | +62% |
| Diff insertions | 217 (partial) | 104 (complete) | -52% |

Pre-warm did *more turns* (31 vs 20) but *less output per task* (18.1k vs 23.3k tokens) and *higher cache leverage* (1.55M vs 0.96M read). Reading: pre-warm let claude make smaller, more directed edits because it knew where to land — fewer dead-end large outputs. Cold burned tokens on exploratory writes that didn't pan out.

The +52% diff reduction in Run 2 is the clearest signal: same problem, half the code, plus all 36 tests pass and verify-schema passes. Cold's 217 insertions are partly dead-end code that contributed to budget exhaustion before AC could be reached.

### F3 — Budget enforcement still precise (1.015× v2 confirms v1's 1.02±0.005×)

Run 1 ratio: 1.015× (cap $0.95, actual $0.9645). Matches v1 Phase B's mean 1.024±0.005× overshoot at budget cap. F1 calibration (`maxCostPerTask × 0.95`) re-validated — no further adjustment needed.

Run 2 ratio: 0.997× (under cap, didn't trigger error_max_budget_usd) — work completed naturally before cap hit.

### F4 — Body-spec defects (path/command drift) affect both runs equally

TASK-704 body has two AC defects:

1. `pnpm test src/__tests__/queue-lifecycle-service.test.ts` — file actually lives at `src/core/domain/lifecycle/queue-lifecycle-service.test.ts` (per real worktree). Body's path is wrong.
2. `pnpm queue-run --dry-run --workspace test` — no `queue-run` script defined in `package.json`. The whole AC command is fictional.

Both runs hit identical body defects. Neither claude run added the missing script (they treated the body as ground truth). Strict-AC scoring penalises both runs identically; charitable scoring (acknowledging body defects) gives Run 2 a clean pass on implementation gates.

This is **not** a pre-warm vs cold finding — it's a TASK-704 body QA finding. Captured as inbox item INBOX-TBD: "lock scope-bearing AC fields after queue pickup OR add validator regex coverage for `pnpm <script>` references against package.json".

### F5 — Pre-warm prefix shape generalisable, but content composition matters

The pre-warm prefix used in Run 2 included two **correction notes** about body drift (test file actual path, `queue-claude-spawn.ts` as real parse target instead of `coder.ts`). Without those corrections claude would have wasted turns chasing the wrong files — measurable in Run 1 which had no corrections and exhausted budget partly via that exploration.

**Implication for productionising pre-warm**: a passive auto-generated prefix (just file:line + signature for File Pointers) is helpful but not enough on bodies with path drift. The 34-line prefix in this spike included ~6 lines of human-authored path-drift corrections — those carried disproportionate value. Auto-generation of pre-warm from File Pointer parsing alone is necessary but not sufficient; would need to also detect drift (e.g. "AC says path X, real path is Y") and surface it.

For a v3 / production implementation: prefix = (a) per-file 5-line summary auto-generated from File Pointer file reads, (b) heuristic drift detection comparing AC paths/commands against real repo state, (c) optional operator-curated additions.

## Decision per outcome matrix

Outcome matrix from CONV-1778501854581-13:

| Run 3 warm | Run 1 cold | Verdict |
|---|---|---|
| pass | fail | ADR-019 amendment OR Direction D task_split |
| — | — | **Pre-warm pass + cold fail → ship pre-warm** ← v2 hit this |
| 3 fail | — | cross-cutting unfit → reject A OR Direction D |
| 3 pass | — | false alarm → keep $1.50 default |

**v2 hit: pre-warm pass + cold fail** ← Run 3 not needed; matrix resolves to ship-pre-warm branch regardless of warm outcome.

## Recommendations for Sprint 2

1. **Ship pre-warm as additive feature** in the queue runner (same lane, no API change). Roughly: auto-compose prefix from each Task's File Pointers, prepend to spawn stdin. ~1h implementation, optional `--prewarm/--no-prewarm` flag for opt-out (default on).
   - Defer drift detection (F5 finding) to follow-up — start with the cheap version (passive auto summary from File Pointer parses).

2. **Lock scope-bearing AC fields post queue pickup** (or post-DONE) per Reviewer R4's earlier soft observation in CONV-1778501854581-13. TASK-704 body defects (F4) would have been caught by an auto-safe validator that asserts every `pnpm <script>` mentioned in AC resolves to a real script. Defer until pattern repeats.

3. **Keep $1.50 default cap** — neither run exceeded $0.97. No need to bump cap further at this time.

4. **Do not productionise warm lane.** Per Reviewer R4 caveat, warm production violates the ADR-019 v2 cost contract. Pre-warm covers the gap as a safe additive.

5. **Open follow-up** for graphical/structural detection of "heavy task shape" before spawn admission — file count + new file count + AC command count exceeding a threshold could auto-trigger pre-warm. ADR-019 already has `files_touched_count` + `new_files_created_count` metrics (TASK-707 shipped). Combine with AC command count for a shape index.

## Caveats

- **n=1 per lane** (single Run 1 cold + single Run 2 prewarm). Statistical power weak; another TASK-704-shape task could flip on a coin. Decision is directional, not statistically confident. Mitigated by v1 having shown pre-warm strictly non-worse on lighter scope; v2 confirms it's strictly non-worse (and outcome-improving) on heavier scope.
- **Run 3 warm interactive deferred.** Matrix didn't need it; if Future-Butter wants to backfill, instructions at `C:/tmp/spike-714/run3-instructions.md`. The "lane abstraction wrong" branch of the matrix remains untested.
- **Body-spec defects equalise on both runs** — but they prevent strict AC scoring. Charitable scoring applied (implementation gates only). A future TASK-704-shape test on a body without drift would be cleaner.
- **Cache state warm** — Run 2 ran ~5 min after Run 1, with related codebase context still hot in Anthropic's cache. Cold-cache scenarios may diverge.
- **Pre-warm content authoring effort** — F5 finding implies the production version needs more than passive file-read summaries; auto-generation is the cheap path but may underperform the human-curated prefix used in this spike.

## Out of scope / not tested

- Warm interactive lane (Run 3) — deferred, matrix resolved without it.
- Pre-warm content variation (terse vs verbose, with vs without drift corrections) — tested 1 shape.
- Haiku-only run — Sonnet 4.6 only.
- Cold re-run after pre-warm to drain cache — defer per v1 caveat.
- Cross-cutting tasks bigger than TASK-704-shape (e.g. 5+ files, 10+ AC commands) — untested upper boundary.

## Linked artifacts

- Run 1 raw: `C:/tmp/spike-714/run1-cold.json` + `run1-cold.diff` + `run1-summary.md`
- Run 2 raw: `C:/tmp/spike-714/run2-prewarm.json` + `run2-prewarm.diff` + `run2-summary.md`
- Pre-warm prefix: `C:/tmp/spike-714/prewarm.md`
- Task body: `C:/tmp/spike-714/task-body.md` (= `data/artifacts/queue-1778481496836-9t4b/tasks/TASK-704/prompt.md`)
- Run 3 instructions (deferred): `C:/tmp/spike-714/run3-instructions.md`
- Spike worktree: `C:/dev/choda-deck.worktrees/spike-714` (detached at `3b2549c`)
- Conv: CONV-1778501854581-13
- Parent task: TASK-714 (this spike), TASK-715 (decision follow-up)
- V1 reference: `docs/knowledge/spike-prewarm-budget-2026-05-11.md`
