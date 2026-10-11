# TASK-2385 — AC verification

Saved run profiles for `/choda-burn-backlog` (INBOX-2150): `~/.claude/skills/choda-burn-backlog/`
`SKILL.md` §0.0 and `profiles.json` (outside git). `/choda-burn-backlog <profile>` loads
auto-merge, pacing, scope and the stop condition from the file and asks nothing.

## Done — 3/3

| # | Criterion | Evidence |
|---|---|---|
| 0 | Skill documents the argument; `profiles.json` has `improve-loop` with the agreed values | both files read: `improve-loop` = autoMerge true, pacing dynamic, projectId choda-deck, labels [improve-loop], stop "no eligible READY"; an `attention` profile is added for this run |
| 1 | Headless `/choda-burn-backlog improve-loop` on an empty backlog → no AskUserQuestion, reports empty | session `b90edc18…`: tool calls Skill, Read, ToolSearch, task_list ×3; **0 AskUserQuestion**; result "Nothing is READY … Run complete: 0 DONE … Backlog remaining: 0 eligible" |
| 2 | `/choda-burn-backlog nope` names the known profiles and starts nothing | session `a2f9ad52…`: result `unknown profile "nope" — known: improve-loop, attention … Nothing started, nothing armed`; one Read, nothing else |

## Findings

- **Git Bash rewrote the slash command.** The first `nope` run launched from Git Bash received a
  Git install path instead of `/choda-burn-backlog` (MSYS path conversion), and the model asked
  what was meant. With `MSYS_NO_PATHCONV=1` it behaved as specified. That run was a harness
  artefact, but it is the same failure archived digest idea INBOX-2195 described: any script that
  launches `claude -p "/skill …"` from Git Bash needs `MSYS_NO_PATHCONV=1`. The Task Scheduler
  launchers use cmd.exe and are not affected.
- The profile run also listed 8 TODO tasks awaiting approval, including TASK-2376 / TASK-2377,
  which came from approving INBOX-2199 / INBOX-2200.
