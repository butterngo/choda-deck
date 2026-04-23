# Session Rules

Behavioral contract for session lifecycle tools. Edit this file to update compliance rules — no MCP restart needed.

## On session_start

`session_start` now requires a `taskId` — the task is bound to the session at creation and auto-set to IN-PROGRESS.

Before calling `session_start`:

1. Call `task_list` (or `roadmap`) to show the user available tasks, grouped by priority (high → medium → low).
2. Wait for the user to pick a task. Do not guess.
3. Call `session_start({ projectId, taskId, workspaceId? })`.
4. Echo the `lastSession` block to the user verbatim — resume point, decisions, loose ends, tasks updated, commits. Do not summarize.
5. Create a feature branch for the task:
   - Branch name: `feat/<task-id>-<short-slug>` (e.g. `feat/task-564-session-conv-ui`)
   - Required: `git checkout -b feat/<task-id>-<short-slug>`
   - Optional (if user wants parallel worktree): detect repo root via `git rev-parse --show-toplevel`, then `git worktree add <repo-root>.worktrees/<slug> -b feat/<task-id>-<short-slug>`
   - Ask the user whether they want a worktree or just a branch before proceeding.

Blocking conditions (MCP returns an error):
- Task not found
- Task already `DONE` — reopen it with `task_update` first
- Task already bound to another active session — end that session first

## On session_end

When preparing the session_end payload, always include:

- **resumePoint** (required) — one sentence describing where you stopped and what the next session should pick up.
- **tasksUpdated** (required if session had a taskId) — list of task ids and their new status.
- **decisions** — architectural or implementation decisions made this session. Explicit > implicit.
- **looseEnds** — anything unfinished, deferred, or noted for later. Include pre-existing issues you touched but did not resolve.
- **commits** — commit SHAs + short message if commits were made.

Never end a session with only resumePoint. If the session was trivial (read-only), explicitly note "no changes" in looseEnds.
