# MCP Rules

Behavioral contract for MCP tools (session + conversation). Edit this file to update compliance rules — no MCP restart needed. Each `## On <tool_name>` section is loaded by the matching tool handler and injected into its response.

## On session_start

`session_start` now requires a `taskId` — the task is bound to the session at creation and auto-set to IN-PROGRESS.

Before calling `session_start`:

1. Call `task_list` (or `roadmap`) to show the user available tasks, grouped by priority (high → medium → low).
2. Wait for the user to pick a task. Do not guess.
3. Call `session_start({ projectId, taskId, workspaceId?, cwd? })`. Always pass `cwd` (current shell directory) so the MCP can auto-detect `workspaceId` for projects with registered workspaces — the MCP server's own cwd is fixed and cannot be inferred.
4. Echo the `lastSession` block to the user verbatim — resume point, decisions, loose ends, tasks updated, commits. Do not summarize.
5. Create a feature branch for the task:
   - Branch name: `feat/<task-id>-<short-slug>` (e.g. `feat/task-564-session-conv-ui`)
   - Required: `git checkout -b feat/<task-id>-<short-slug>`
   - Optional (if user wants parallel worktree): detect repo root via `git rev-parse --show-toplevel`, then `git worktree add <repo-root>.worktrees/<slug> -b feat/<task-id>-<short-slug>`
   - Ask the user whether they want a worktree or just a branch before proceeding.

Workspace resolution order (when project has ≥1 workspace registered):
- explicit `workspaceId` wins
- else `cwd` is matched against registered workspace cwds (longest prefix wins for nested repos)
- else MCP throws — pick a workspace explicitly or call `workspace_add`

If the project has no workspaces registered, `workspaceId` may be `null` (backward-compatible).

Blocking conditions (MCP returns an error):
- Task not found
- Task already `DONE` — reopen it with `task_update` first
- Task already bound to another active session — end that session first
- Project has workspaces but neither `workspaceId` nor a matching `cwd` was provided

## On session_checkpoint

`session_checkpoint` snapshots progress on an active session **without ending it**. Overwrite-in-place — each call replaces the previous checkpoint.

When to checkpoint:

- Before risky operations (rebase, force-push, schema migration, large refactor)
- Before context window compaction (when conversation grows long)
- Every ~30 minutes of active work, or after a meaningful sub-step
- When pausing work mid-task (lunch, meeting) — so a future `session_resume` recovers state cleanly

Required field:

- **resumePoint** — one sentence describing exactly where you stopped and what to pick up next

Recommended fields (include whichever apply):

- **lastConversationId** — most recent conversation touched (resume context)
- **dirtyFiles** — files edited but not yet committed (so resume knows what's in flight)
- **lastCommit** — last commit SHA written this session (resume git position)
- **notes** — free-form context that matters for resume (decisions made, dead ends ruled out)

Do not call `session_checkpoint` as a substitute for `session_end`. Checkpoint = pause; end = finalize + handoff.

## On session_resume

`session_resume` returns the session row, last checkpoint, linked conversations, and active context sources. Use after crash, restart, or context compaction — not as a way to spawn a new session for the same task.

After calling `session_resume`:

1. **Echo the checkpoint summary verbatim** — `resumePoint`, `notes`, `dirtyFiles`, `lastCommit`, `lastConversationId`. Do not summarize. Butter needs the same view the prior session had.
2. **Confirm task binding** — name the `taskId` and current status. If the task is no longer IN-PROGRESS, surface the discrepancy before proceeding.
3. **Resume from `resumePoint`** — pick up the exact next step. Do not re-plan from scratch.
4. **Do not call `session_start`** — resume reactivates the existing session; starting a new one orphans the checkpoint and creates duplicate state.

If no checkpoint exists (resumed session was never checkpointed), say so explicitly and ask Butter where to pick up before continuing.

## On session_end

When preparing the session_end payload, always include:

- **resumePoint** (required) — one sentence describing where you stopped and what the next session should pick up.
- **tasksUpdated** (required if session had a taskId) — list of task ids and their new status.
- **decisions** — architectural or implementation decisions made this session. Explicit > implicit.
- **looseEnds** — genuine ideas that need future research. NOT a catch-all dump. See classification rule below.
- **commits** — commit SHAs + short message if commits were made.

Never end a session with only resumePoint. If the session was trivial (read-only), explicitly note "no changes" in resumePoint or notes.

### Classify each loose end BEFORE writing it

Every candidate loose end falls into exactly one of 3 buckets. Pick the bucket first, then route accordingly:

1. **Action item** (has clear owner + acceptance criteria) → call `task_create` directly with status=TODO or READY. Do NOT put it in `looseEnds`. Examples: "PR #5 awaiting merge — on merge delete branch", "revert TASK-X to READY before next queue start", "companion repo 2 commits ahead — needs push".
2. **Dirty-state observation** (untracked file, stale branch, cosmetic shell handle, lingering process) → put it in `notes` field or the commit message. Do NOT put it in `looseEnds`. Examples: "stale worktree at .worktrees/foo", "Windows file handle on dist/", "untracked spike notes in /tmp".
3. **Genuine idea needing research** (open question, design uncertainty, "should we…?") → `looseEnds` (this is the legitimate use). Each entry: 1 line, concrete, no acceptance criteria yet. Example: "investigate whether prewarm cache can survive worktree switch".

`looseEnds` are auto-converted to inbox entries (status=raw) under the session's project — one entry per item, tagged with the source session/task ID. Butter reviews the inbox in `/daily` and decides which deserve `inbox_convert` → task. If you find yourself dumping action items or observations into `looseEnds`, you skipped step 1 — go back and classify.

## On conversation_read

Discussion etiquette (advisory, injected only when `conv.status` is `open` or `discussing`; skipped for `decided`/`closed`/`stale`):

- Read the full thread first. Don't restate prior points unless correcting them.
- State your position in 1 line, then 2-3 concrete reasons (not generic pros/cons).
- Address the latest unresolved point. If you disagree, challenge it directly — don't add parallel views.
- When you see convergence, propose a decision and name any remaining risk briefly.
- Cover business + implementation + test impact when relevant; skip non-applicable angles.
- Keep it proportional. Small threads stay short.
