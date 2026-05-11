---
title: Spike Pre-warm + Budget Enforcement (ADR-019 Phase 2)
date: 2026-05-11
status: complete
linked_task: TASK-705
linked_conv: CONV-1778483640100-2
related_adrs: [ADR-017, ADR-019]
---

# Spike: pre-warm spawn context + budget enforcement repeat-test

## TL;DR

1. **Budget enforcement is exact** — Claude self-aborts at **1.02-1.03×** budget arg, NOT 2× as ADR-017 assumes. `/2` formula over-corrects → re-calibrate.
2. **Pre-warm reduces cost 23.5% + turns 50%** on TASK-707-shaped task. Under spike's 30% ship-gate but practically meaningful.
3. **Default `maxCostPerTask = 0.50` is too tight**: Phase B shows TASK-707 (4-file extend, ~30ph human-estimate) fails at $0.50. Need ≥$0.70 to complete.

## Method

Test task: TASK-707 body (`Extend queue-run.json metrics: files_touched_count + new_files_created_count`) — cross-cutting shape (4 files modified, 0 new file, AC commands, ~30ph human estimate).

Isolated worktree `C:/dev/choda-deck.worktrees/spike-705` on `main` (clean fbcec4d). Reset between spawns.

Spawn signature replicates queue runner exactly (`queue-claude-spawn.ts:38-58`):
- `claude -p` with `--strict-mcp-config --mcp-config queue-mcp-empty.json` (zero MCP)
- `--tools "Read,Edit,Write,Bash,Grep,Glob"`
- `--allowed-tools "Bash(pnpm *) Bash(node *) Bash(git diff*) Bash(git status*)"`
- `--permission-mode bypassPermissions`
- Stdin = task body (Phase A1, B) OR pre-warm prefix + task body (Phase A2)
- Vary `--max-budget-usd` per phase

Pre-warm prefix content: per-file 5-line summary (file purpose + key line numbers + helper signatures) for each File Pointer in TASK-707 body. ~30 lines total prefix.

## Raw data

| Phase | Budget arg | Actual cost | Ratio (actual/budget) | Turns | Output tokens | Cache read | Subtype | Notes |
|---|---|---|---|---|---|---|---|---|
| A1 baseline | $1.00 | $0.677 | **0.68×** (under) | 40 | 10,080 | 1,154,100 | success | 103 insertions, all AC pass |
| A2 pre-warm | $1.00 | $0.518 | **0.52×** (under) | 20 | 13,155 | 626,428 | success | 101 insertions, all AC pass |
| B-010 | $0.10 | $0.103 | 1.027× | 9 | 985 | 61,760 | error_max_budget_usd | early exit, no useful diff |
| B-025 | $0.25 | $0.257 | 1.027× | 18 | 4,355 | — | error_max_budget_usd | partial diff, AC unmet |
| B-050 | $0.50 | $0.508 | 1.017× | 32 | 8,058 | — | error_max_budget_usd | substantial diff, AC unmet |

Total spike cost: **$2.06** (within $4 budget cap).

### Reference data from prior dogfood (TASK-704)

| Run | Budget | Actual | Ratio | Result |
|---|---|---|---|---|
| TASK-704 Run 1 | $0.25 | $0.41 | **1.64×** | fail (outlier — see analysis) |
| TASK-704 Run 2 | $1.00 | $1.00 | 1.00× | fail (80% diff) |

## Findings

### F1 — Budget enforcement is precise, not 2× overshoot

ADR-017 assumes Claude `-p` may overshoot budget arg by ~2×. **Empirically false** for Sonnet 4.6 + current CLI version.

Phase B mean overshoot ratio when claude self-aborts at cap: **1.024× ± 0.005** (n=3, range 1.017-1.027).

TASK-704 Run 1 outlier ($0.25 → $0.41, 1.64×) is **anomalous**. Hypotheses:
- Cold-cache state (first dogfood run, no recent claude session on codebase)
- Different effective task complexity (TASK-704 itself was the metrics implementation, not TASK-707)
- Some interaction between low budget + lots of cache-creation tokens

Sample size n=1 outlier — should not drive design.

**Recommendation F1**: Change `maxBudgetUsd = maxCostPerTask / 2` → `maxBudgetUsd = maxCostPerTask × 0.95` (or simply `= maxCostPerTask`). The 5% margin covers observed 1.02-1.03× overshoot. Current `/2` formula wastes 47% of headroom.

### F2 — Pre-warm impact: -23.5% cost, -50% turns

| Metric | A1 baseline | A2 pre-warm | Delta |
|---|---|---|---|
| total_cost_usd | $0.677 | $0.518 | **-23.5%** |
| num_turns | 40 | 20 | **-50%** |
| output_tokens | 10,080 | 13,155 | +30% |
| cache_read_input_tokens | 1.15M | 626k | -46% |
| diff insertions | 103 | 101 | similar |
| AC pass | ✓ | ✓ | both ship-ready |

Pre-warm halved exploration turns. Output tokens went UP — claude wrote more per turn (less duplicated read-then-write cycles). Net cost saving 23.5%.

23.5% is **under** the 30% spike ship-gate defined in TASK-705 body. Per spike contract → do not auto-ship pre-warm in Sprint 1.

However, **turn count and time-to-complete halved** — operational benefit independent of cost. Worth shipping if implementation cost is low.

**Recommendation F2**: Defer auto-shipping pre-warm. Instead:
- Document in ADR amendment: pre-warm hypothesis confirmed marginal but real.
- Consider OPT-IN flag `--prewarm` on `run-queue` CLI — operator can prepend per-task File Pointer summaries when retrying a failed task. Cheap to add (~30ph).
- Re-test on TASK-704-shape (heavier scope) — TASK-707 was relatively simple; pre-warm benefit may scale with task complexity.

### F3 — Default `maxCostPerTask = 0.50` is empirically too tight

Phase B-050 ($0.50 budget) failed: claude self-aborts at $0.508 with substantial but incomplete diff. Combined with `/2` formula → default config spawns $0.25 in-flight, which fails even on TASK-707-shape (simpler than ADR-019 envisioned).

**Recommendation F3**: Bump `DEFAULT_MAX_COST_PER_TASK` from `0.50` → **`1.00`** (matches TASK-711 proposal). Combined with F1's `× 0.95` formula → spawn budget effectively $0.95. TASK-707 completed at $0.518-$0.677 (under), so $0.95 has comfortable headroom for similar-shape tasks.

For cross-cutting heavier tasks (TASK-704 shape): default $1.00 still insufficient. Either:
- Require explicit `--max-cost-per-task` per queue invocation (operator discipline), OR
- Per-task body declaration `max-cost: <usd>` parsed by validator (autonomous discipline).

### F4 — Cache state affects measurement; absolute costs not portable

A1 baseline cache_read = 1.15M (cache warm from prior TASK-704 PR merge ~15min before spike). A2 pre-warm cache_read = 626k (different prompt prefix → less cache hit).

Both ran during warm-cache period. Cold-cache costs would be higher. Phase B (smaller budgets) had less time to warm cache → less cache benefit.

**Caveat for Sprint 1 decision**: Absolute cost numbers from this spike are **upper-bound estimates for warm-cache scenarios**. Cold-cache real workload may cost 1.5-2× more. The /2 formula re-calibration (F1) is still valid (it's about overshoot ratio, not absolute cost). The default cap bump (F3) should account for cold-cache: consider $1.50 instead of $1.00.

## Decision gate (per TASK-705 body)

Spike body decision rules:
- Pre-warm cost reduction ≥30% → ship pre-warm, keep default $0.50.
- <30% → tactical cap bump with evidence.
- Budget enforcement exact (≥3/4 runs) → re-calibrate `/2` formula.

Results:
- Pre-warm = 23.5% → **<30%**. Per gate: tactical cap bump.
- Budget enforcement 3/3 Phase B exact (within 1.05×) → **re-calibrate** `/2` confirmed.

## Recommendations for Sprint 1 sequencing

**Highest-leverage, lowest-risk first**:

1. **Re-calibrate `/2` formula** → `× 0.95` (or `= 1.0`). ~10ph. Affects single line `queue-lifecycle-service.ts:163`. Update unit test default expectations.

2. **Bump default `maxCostPerTask` 0.50 → 1.50** (cold-cache safety). ~5ph. Single constant + test + CLI help text. TASK-711 already proposes 1.00; revise to 1.50 with this spike's data.

3. **Defer pre-warm auto-implementation**. Document ADR amendment about hypothesis status. Open follow-up task for OPT-IN `--prewarm` flag (low priority, ~1h).

4. **Open follow-up task** for pre-warm validation on TASK-704-shape (heavier scope): does pre-warm benefit scale with task complexity? Run when next TASK-704-shape auto-safe task is in queue.

## Out of scope / not tested

- Phase A2 cache prefix difference may have undercounted pre-warm benefit (less cache hit due to different prompt prefix). Future spike: control for cache hit by re-running A1 after A2 to drain cache, then compare A1' vs A2.
- Haiku-only Phase B (would `--model claude-haiku-4-5-20251001` change overshoot behavior?). Not tested.
- Pre-warm content variation (terse vs verbose, file paths only vs full summaries). Tested 1 shape only.
- Tasks with 0 cache hit (cold workspace). Spike ran on warm-cache. Phase B at $0.10 had cache_read=62k (low but nonzero).

## Linked artifacts

- Raw claude.json outputs: `C:/tmp/spike-705/claude-{baseline,prewarm,b010,b025,b050}.json`
- Pre-warm prompt content: `C:/tmp/spike-705/prewarm-prompt.txt`
- Spike worktree: `C:/dev/choda-deck.worktrees/spike-705` (branch `feat/task-705-spike-report`)
- Conv: CONV-1778483640100-2
- Parent task: TASK-705
- Sibling deferred decisions: TASK-711 (cap bump 0.5→1.0, revise to 1.5 per F3)
