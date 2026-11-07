# Goal: lifecycle and knowledge writes record only what actually happened — run summary

Goal TASK-3138 · feature `trustworthy-records` · PR https://github.com/butterngo/choda-deck/pull/381 · run branch `autopilot/TASK-3138-2026-11-07`

## What was finished

- **Editing a knowledge note no longer marks it as freshly verified** (TASK-3139, d55c6a7). `knowledge_update` with only a body used to re-pin every ref to the current HEAD and set `lastVerifiedAt` to today, so an edit read as a review and erased the staleness signal (INBOX-1951). A body-only update now keeps both; only `knowledge_verify`, or an update that passes `refs`, moves them. A body-only update also no longer needs git at all.
- **Archiving or converting an inbox item closes its thread durably** (TASK-3140, fa63fde). The old code wrote the conversation header directly, which the next refold (a new message or a sync merge) silently undid (INBOX-1714). The close is now a `decision` turn in the message log, followed by one `signoff` per registered participant, then a refold. The signoffs were added mid-run on Butter's decision: inbox research threads always register `Butter` + the researcher, so without them every such thread would stay `open` forever.
- **Cancelling a session no longer closes unrelated threads** (TASK-3141, f13210f). `session_cancel` used to mark every linked thread decided with `Abandoned: <reason>` (INBOX-1709). It now leaves all of them as they are and returns `closedConversationIds: []`, the same rule `session_end` follows since TASK-1621.
- **A session can no longer start in a workspace that does not exist** (TASK-3142, e5ee0bb). `session_start` accepted any `workspaceId`, so a typo (`companion` instead of `choda-deck-companion`) produced a session whose every later `ac_check` failed (INBOX-2331). It now refuses unknown or archived ids with `WORKSPACE_RESOLUTION_FAILED` and lists the registered workspaces; the companion's `POST /sessions` answers 400 the same way.

Numbers: 25/25 acceptance criteria ticked, 18 test cases added, full suite 2920 passed / 57 skipped / 0 failed on the last item (docs/reports/task-3138-test-report.md). Every new test was also run against the pre-fix code and failed there.

## Not finished

Nothing. No blocked items, no human-class criteria. Out of scope by design: threads already closed wrongly in the past stay as they are (repair with `conversation_reopen`), and nothing limits agents calling `knowledge_verify` in bulk.

## How to use it

Nothing changes until the PR is merged and the MCP bundle is rebuilt (`pnpm run build:mcp`, then `/mcp reconnect`).

- **Verify a knowledge note on purpose**: call `knowledge_verify({ slug })` after re-reading it against the code. `knowledge_update({ slug, body })` now leaves `lastVerifiedAt` and the pins alone (source: test `body-only update keeps pins and lastVerifiedAt`).
- **Start a session with an explicit workspace**: `session_start({ projectId, taskId, workspaceId })`. A wrong id returns `WORKSPACE_RESOLUTION_FAILED` with the list of valid ids and creates nothing; the task stays READY (source: smoke check 1 on a scratch copy of the database).
- **Cancel a session**: `session_cancel({ sessionId })` ends the session and leaves its linked threads open (source: smoke check 3).
- **Archive or convert an inbox item**: no change in the call. Its research thread now ends `decided`, with the decision and the signoffs visible in `conversation_read` (source: test `a research thread (Butter + researcher) gets one signoff per participant and closes`; not tried against the live database).
