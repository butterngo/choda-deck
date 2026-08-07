---
type: gotcha
title: Never reuse the sessionId echoed by ac_check — it may be another agent's session
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-08-05
lastVerifiedAt: 2026-08-05
affectedFeatureId: feature-session-lifecycle
---

## Trigger

Calling `ac_check`, then `session_end`, in a workspace where more than one agent may be
working. Increasingly ordinary — concurrent Claude sessions on one repo are normal now.

## Context

Two tool contracts disagree:

- `session_start` — "Multiple active sessions per workspace are allowed, but a task can
  only be linked to one active session at a time."
- `ac_check` — takes no `sessionId`, resolves one from `cwd` → workspace, and its own
  description says "one active session per workspace (ADR-009)."

When there are two, `ac_check` silently picks one and **echoes that id in its response**,
which reads like "the session you are in."

Observed 2026-08-05:

```
12:19:21.197  session_start(TASK-1569) -> SESSION-...361197-91   (mine)
12:19:21.688  session_start(TASK-1576) -> SESSION-...361688-21   (another agent, +491ms, same workspace)
12:19:29      ac_check(TASK-1569, ...) -> echoed SESSION-...361688-21   <-- theirs
12:19:36      session_end(SESSION-...361688-21) -> TASK-1576 -> IMPLEMENTED
```

The AC tick landed on the right task; the attribution did not. Passing the echoed id to
`session_end` closed another agent's in-flight session and flipped their untouched task to
IMPLEMENTED, with an unrelated summary attached. TASK-1576 had to be restored by hand; the
session could not be un-ended.

## Business rule

**Use the `sessionId` your own `session_start` returned. Treat `ac_check`'s echoed id as
information about the server's guess, never as your session handle.**

Before `session_end`, verify the id you are about to pass is the one you were given. If it
differs, stop — you are about to close someone else's work.

## Resolution

Until the tool is fixed (TASK-1577, filed and currently declined):

1. Keep the id from `session_start` in hand and pass *that* to `session_end`.
2. Compare `ac_check`'s echoed `sessionId` against it; a mismatch is a red flag, not a
   detail.
3. `session_list({ status: 'active' })` before closing when concurrency is plausible —
   different workspaces are safe, the same workspace is not.
4. The same assumption is baked into the `/session-end` skill ("find the active session,
   end it"), so following it literally in a shared workspace reproduces the bug. It fired
   a second time the same afternoon.

## Related

- TASK-1577 — the tool fix (optional `sessionId`, refuse-on-ambiguity, `expectTaskId`
  guard on `session_end`). Filed high; declined for now, so this gotcha is the mitigation.
- TASK-1576 — the task damaged and restored
- ADR-009 — session lifecycle, which predates concurrent agents
