# TASK-2358 — AC verification

Skill `~/.claude/skills/improve-loop/SKILL.md` (outside git, TASK-2352 Q3). Every
criterion was run for real: headless `claude -p "/improve-loop choda-deck-companion"
--model sonnet --allowedTools <RUN_ALLOWED_TOOLS> --output-format json` from `C:\dev\choda-deck`,
the same command the companion's Run now spawns, against the companion with its config at
`.choda/improve.json` (the TASK-2353 fixture).

## Runs

| Run | Setup | Outcome |
|---|---|---|
| 1 | first scorecard of the day | measured 993/993, LCP 180 ms; evaluator **called** (no earlier score); UI scannable 3.5; 1 proposal, INBOX-2192 |
| 2 | same day, same commit, every page `uiChanged: false` | measured; evaluator **skipped**, 3.5 carried over; 0 proposals (the only candidate duplicated pending INBOX-2192) |
| 3 | every criterion `good: true` | `mode: "off"` written, 1 stop note (INBOX-2193, archived as a test artifact) |
| 4 | same as 3, final skill | `mode: "off"`, 1 stop note `[improve-note:…]` (INBOX-2194, archived); config restored to `manual` |

## Done — 3/5

| # | Criterion | Evidence |
|---|---|---|
| 1 | Every proposal starts with `[improve:<ws>]`; a run posts ≤ `maxProposals` | run 1: 1 of 3, run 2: 0; the raw inbox holds exactly one `[improve:` item |
| 3 | All criteria good → `mode: "off"` + one inbox item saying why | runs 3 and 4 both; the file was replaced by rename, no `.tmp` left |
| 4 | No image data in inbox items; screenshots only as local paths | all three created items are plain text under 700 chars, with the path `…/2026-10-10/projects.png` |

## Not done — 1

**AC-0: no UI change → evaluator not called, and `usage` reports <20k total tokens.** The
first half holds: run 2's transcript has no `Task` call. The second half cannot hold as
written:

| Run 2 | Tokens |
|---|---|
| `usage` total (input + cache creation + cache read + output) | 495,756 |
| non-cached (input + cache creation + output) | 32,844 |
| cost | $0.24 |

A headless run starts with ~38k tokens of base context (system prompt, tool schemas, global
and project CLAUDE.md, MCP instructions) before the skill does anything, and every turn
re-reads it from cache. One turn is already over 20k. Run 2 took 13 turns, and one of them
was `inbox_list`, whose choda-deck answer is ~119k characters and had to be grepped from a
spill file.

Needs a decision, not a retry: measure non-cached tokens (or cost), raise the bound
(e.g. <50k non-cached), or shrink the base (a narrower `--mcp-config`, an `inbox_list` filter
by prefix). Filed as a follow-up.

## Needs a human / time — 1

**AC-2: three consecutive manual days with no repeated or rejected proposal.** It needs three
calendar days. Run 2 shows the duplicate check working within a day (it dropped the only
candidate because INBOX-2192 covered it), which is not the criterion.

## Findings

- **Notes must not look like proposals.** Run 3's stop note started with
  `[improve:<ws>]` and was `raw`, so the companion's Improve tab would list it as a proposal
  and "approve" would turn it into a task. The skill now tags stop notices and "Rate 1–5"
  questions `[improve-note:<ws>]`; run 4 confirmed it.
- **Same-day reruns erased agent scores.** `improve measure` rewrites today's scorecard with
  `null` agent values, so a second run would always call the evaluator. The skill now reads
  today's file before measuring and carries those scores over (run 2).
- **Run 4 skipped measuring** because the stop check only needs the config. The skill now
  says to measure on every run.
- **`inbox_list` is the expensive call.** choda-deck's inbox is large and the tool has no
  content filter, so each run pays for the whole list.
- `.choda/improve.json` now exists in choda-deck-companion, untracked. It is the TASK-2353
  fixture with `mode: manual`. Whether to commit it is the pilot's call (TASK-2362).
- INBOX-2192 ("Label and darken the workspace count in project rows") is a real proposal,
  left pending for Butter.
