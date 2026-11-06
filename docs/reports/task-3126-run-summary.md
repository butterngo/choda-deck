# Personal operating rules: the system reminds and blocks on Butter's 5 rules — run summary

## What was finished

- **You can see how many projects you really worked on this week** (TASK-3127, 5ffadb9). The five rules cap ownership at 4 projects a week, but nothing counted them: the daily digests record minutes per folder, and one project spans several repos and worktrees. `activity week` now folds the digests into choda projects (worktrees counted with their repo, unregistered repos as their own project, the dev root / scratch / home / `~/.claude` / vault ignored) and lists every project with at least 60 minutes. On the real data for 2026-W45 it lists 10 projects; the top four are juvenis-maxime 1490, ba-nghiep 1090, mavue-studio 990 and tms 785 minutes (smoke check 1). `activity week pick` records the week's 4 and refuses a fifth.
- **Every new project has to say what it gives you** (TASK-3128, 11397ca). Rule 4 asks each project for income, reputation or fun. `project_add` now refuses a new project without one of those values and writes nothing; `project_update` can set it; `project_list({ missingPurpose: true })` lists the projects that still have none. The value is stored on both SQLite and Postgres and travels with sync.
- **A new autopilot run stops when it would break rule 1 or 2** (TASK-3129, 1748817 + choda-skills d8c027a). `rules check <project>` answers pass (exit 0) or blocked (exit 3), with each reason numbered: not one of the week's picked projects (rule 1), a green PR still unmerged, or a task still waiting for your check (rule 2). `/choda-autopilot` runs it once when a run starts; only your explicit "override rule N" in the session lets the run continue. When a picked project has nothing left open, `activity week swap <out> <in>` hands its slot to another project; with work still open it refuses unless you pass `--override "<reason>"`, which is recorded.
- **Every Claude Code session warns you when it opens in such a project** (TASK-3130, feb751c). About two thirds of active time is hand work that never meets the autopilot gate (W44 34% and W45 32% of active time ran in autopilot worktrees, from the daily digests), so a SessionStart hook runs the same check for the session's folder and adds the reasons to the session. It never blocks and always exits 0.

## Not finished

- **TASK-3128 AC-6** — the Postgres migration test (`020_project_purpose`) needs Docker, which this laptop does not have. CI on PR #380 is meant to prove it; the task stays IN-PROGRESS until it is ticked.
- **TASK-3131 (Monday digest additions)** — not started: it waits for TASK-3128 to close.
- **TASK-3130 AC-6 (human)** — open a new Claude Code session in a repo of a project that is not picked this week, and confirm the rule-1 warning shows.
- **The SessionStart hook is already registered** in `~/.claude/settings.json`, pointing at `C:\dev\choda-deck\scripts\hooks\rules-warn.mjs`. That file exists in the main checkout only after PR #380 is merged and pulled; until then each new session shows a non-blocking hook error.

## How to use it

- **See this week's projects**: `choda-deck activity week` (or `--json`, `--week 2026-W45`). You should see one line per project with its minutes, unregistered repos marked, and the current pick. Ran on the real data dir (smoke check 1).
- **Pick the week's 4**: `choda-deck activity week pick juvenis-maxime ba-nghiep mavue-studio tms`. Five ids, or an id that is not a project, exits 1 and writes nothing (CLI tests). Not run against the real data dir (not tried) — doing it is the after-deploy step.
- **Check a project before starting work**: `choda-deck rules check <project>`. Against choda-deck today it answers blocked, with rule 1 (no pick for 2026-W45 yet) and rule 2 (TASK-3127 and TASK-3129 waiting for your check) (smoke check 2).
- **Hand over a finished project's slot**: `choda-deck activity week swap <out> <in>`; add `--override "<reason>"` to force it while work is open (CLI and unit tests; not tried on real data).
- **Give a project its purpose**: `project_update({ id, purpose: 'income' | 'reputation' | 'fun' })`; list the gaps with `project_list({ missingPurpose: true })` (MCP tool tests; not tried on the live server — it needs `pnpm run build:mcp` and `/mcp reconnect` after merge).
