# TASK-2361 — AC verification

`scripts/install-improve-loop-task.mjs`: installs `\ChodaImproveLoop` (daily 08:45). The
task runs the same script with `--run`, which picks the workspaces whose
`.choda/improve.json` says `mode: "scheduled"` **at run time** and runs
`claude -p "/improve-loop <ws>" --model <model>` for each, one after another. Plus the
amendment to `adr-when-this-project-may-call-a-model`.

Per the TASK-2352 plan the task is **not left installed**: the pilot (TASK-2362) installs it.

## Done — 4/4

| # | Criterion | Evidence |
|---|---|---|
| 0 | Launcher unit test: scheduled / manual / off → only scheduled invoked | `install-improve-loop-task.test.ts` 'AC-1': real temp dirs with the three configs; the injected invoker sees exactly `web:opus`. Further tests skip no config, broken JSON, archived and unsafe ids, and keep going after one workspace fails |
| 1 | Install registers `ChodaImproveLoop` daily at 08:45 | `schtasks /Query /TN ChodaImproveLoop /V`: `Schedule Type: Daily`, `Start Time: 8:45:00 AM`, `Next Run Time: 10/11/2026 8:45:00 AM`, `Task To Run: wscript.exe "…\improve-loop-hidden.vbs"` |
| 2 | `--uninstall` removes it; the query then reports it does not exist | `schtasks /Query /TN ChodaImproveLoop` → `ERROR: The system cannot find the file specified.` (exit 1); launcher and VBS deleted. Done twice, the second time with the final script |
| 3 | The ADR has an amendment section for opt-in scheduled runs | `docs/knowledge/adr-when-this-project-may-call-a-model.md` § "Amendment — 2026-10-10: opt-in scheduled runs (improve loop)"; `lastVerifiedAt` bumped |

## Live runs under Task Scheduler

- **First `schtasks /run` failed, exit 1: `spawnSync git ENOENT`.** The worktree check
  ran before `--run`, and `git` is not on a scheduled task's PATH. Fixed: `--run` returns
  before the check and takes the data dir from the launcher's `CHODA_DATA_DIR`. Rerun:
  `0 scheduled: (none)`, exit 0, `LastTaskResult 0`.
- **The `claude.cmd` command line.** Checked without spending tokens: `--claude` pointed at
  a fake `.cmd` in a path with a space that echoes its arguments, with the companion briefly
  set to `scheduled` / `haiku`. It received `"-p" "/improve-loop choda-deck-companion"
  "--model" "haiku" "--allowedTools" "Bash Read Glob Task mcp__choda-tasks__inbox_add
  mcp__choda-tasks__inbox_list"` as six tokens, and its exit code 7 came back. The
  config was then restored to `manual`.
- **No `git` on PATH** (this PowerShell) now gives a one-line error naming `--data-dir`
  instead of a stack trace. `install-activity-digest-task.mjs` still has the old behaviour.

## Findings

- **Run-time selection, not install-time.** The plan says turning a workspace on or off is
  only an edit to `mode`; baking the list into the launcher would have needed a reinstall.
- **No logon trigger**, unlike ChodaActivityDigest: a missed 08:45 runs at the next chance
  (`StartWhenAvailable`), not on every sign-in. The limit is 2 hours; each `claude` run is
  capped at 25 minutes.
- **The ADR ref list does not name the new script.** Knowledge refs need a `commitSha`, and
  the script has none until this merges. The amendment names the path in its text.
- Gates: typecheck; the new tests 6/6 and the activity installer's 5/5; the full suite failed
  only `mermaid-check` (hook timeout) and `workspace-diagram` (timeout), both documented
  flakes, both 29/29 on rerun; lint has 0 errors (one warning in an untouched file;
  `scripts/` is not linted). No build artifact consumes `scripts/`.
