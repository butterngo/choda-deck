# Session Rules

Behavioral contract for session lifecycle tools. Edit this file to update compliance rules — no MCP restart needed.

## On session_start

Before any other action in this session:

1. Echo the lastHandoff block to the user verbatim — resume point, loose ends, decisions, tasks updated. Do not summarize.
2. List activeTasks grouped by priority (high → medium → low).
3. Wait for user acknowledgement before calling session_pick or doing any work.

## On session_end

When preparing the session_end payload, always include:

- **resumePoint** (required) — one sentence describing where you stopped and what the next session should pick up.
- **tasksUpdated** (required if session had a taskId) — list of task ids and their new status.
- **decisions** — architectural or implementation decisions made this session. Explicit > implicit.
- **looseEnds** — anything unfinished, deferred, or noted for later. Include pre-existing issues you touched but did not resolve.
- **commits** — commit SHAs + short message if commits were made.

Never end a session with only resumePoint. If the session was trivial (read-only), explicitly note "no changes" in looseEnds.
