# TASK-2366 — AC verification

A quiet improve-loop day (no UI change) now stays under 40k non-cached tokens. Two changes:

1. **Skill** (`~/.claude/skills/improve-loop/SKILL.md`, outside git): reads this workspace's
   `[improve:<ws>]` / `[improve-note:<ws>]` items with one read-only SQL query (1,656 characters)
   instead of `inbox_list`, which returned the whole choda-deck inbox (~119k characters).
2. **Runners** (this PR): the companion's Run now (`src/adapters/companion/improve.ts`) and
   ChodaImproveLoop (`scripts/install-improve-loop-task.mjs`) write an MCP config containing only
   the user's `choda-tasks` server, read from `~/.claude.json`, and pass `--strict-mcp-config
   --mcp-config <file>`. Every other connector's tool schemas cost ~6k tokens per run and the loop
   uses none of them. With no `choda-tasks` entry, nothing is written and the run loads the full
   config as before.

## Runs (companion, every page `uiChanged: false`)

| Run | Setup | Non-cached tokens | First-turn cache write | Largest tool result | `Task` calls |
|---|---|---|---|---|---|
| A | narrower inbox read only | 44,116 ❌ | 31,818 | 2,233 chars | 0 |
| B | + `--strict-mcp-config` (choda-tasks only) | **37,936** ✅ | 26,087 | 5,693 chars | 0 |

Non-cached = input + cache creation + output, summed over `modelUsage` (one model, sonnet).
Run B cost $0.22; the TASK-2358 baseline was 32,844 non-cached tokens but read 119k characters of
inbox, and cost $0.24.

## Done — 2/3

| # | Criterion | Evidence |
|---|---|---|
| 0 | Quiet day: non-cached < 40,000 and no `Task` call | run B: 37,936, 0 `Task`/`Agent` calls in transcript `2e57e39d…`. Run B used the flags these runners now pass; the fake-`claude.cmd` check shows `--run` passing exactly `--strict-mcp-config --mcp-config C:\dev\choda-deck\data\improve-mcp.json` |
| 1 | No tool result larger than 20,000 characters | run B: largest 5,693; run A: 2,233 (the TASK-2358 baseline had a ~119k `inbox_list` result) |

## Needs time — 1

**AC-2, 3 consecutive manual days with no repeated or rejected proposal.** Needs calendar
days. Within today, run A's duplicate check dropped the "count column" idea because approved
INBOX-2192 covers it. Run B filed nothing, citing pending INBOX-2199. Carried as a follow-up.

## Findings

- **The margin is thin: 2k tokens.** Most of the budget is the base context written to cache on
  the first turn (26k). A run started from `C:\dev\choda-deck` also loads that repo's CLAUDE.md;
  the companion currently spawns from `C:\Windows\System32` (TASK-2368), which is cheaper but
  wrong for transcripts. Fixing TASK-2368's cwd may push a quiet day back over 40k.
- **Run A filed INBOX-2199 ("Fix 2 failing DocDiagrams tests")** because the measure hit the
  companion's flaky pair (843/845). Run B measured 993/993 and called INBOX-2199 stale. The loop
  turns a flaky test into a proposal; the flake itself is the thing to fix.
- **Gates:** typecheck; `improve.test.ts` + installer tests 23/23; full suite 185 files /
  2442 tests green; eslint clean on touched files; `build:companion` ok.
- **0.18.6's bundled adapter does not have this.** The app's own Run now keeps loading every
  connector until the next companion release.
