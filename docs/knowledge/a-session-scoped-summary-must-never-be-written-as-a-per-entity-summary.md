---
type: gotcha
title: A session-scoped summary must never be written as a per-entity summary
projectId: choda-deck
scope: project
refs:
  - path: src/core/domain/lifecycle/session-lifecycle-service.ts
    commitSha: 8196107e0024ed9e5aacab466b5c296f352b17dc
  - path: src/core/domain/interfaces/session-lifecycle.interface.ts
    commitSha: 8196107e0024ed9e5aacab466b5c296f352b17dc
  - path: src/adapters/mcp/rules/mcp-rules.md
    commitSha: 8196107e0024ed9e5aacab466b5c296f352b17dc
createdAt: 2026-08-10
lastVerifiedAt: 2026-08-17
affectedFeatureId: feature-session-lifecycle
---

## Trigger

You are closing out a parent operation (a session, a batch, a run) that has N linked child entities, and you reach for one summary field on the parent to stamp all N children. Or you write a fallback chain like `input.perChildSummary ?? parent.someSummary ?? 'default'`.

## Context

`session_end` used to close **every** conversation merely *linked* to the session and stamp each one's `decisionSummary` with the session's own `handoff.resumePoint`:

```ts
const decisionSummary =
  input.decisionSummary ?? input.handoff.resumePoint ?? 'Session ended'
for (const conv of this.conversations.findByLink('session', id)) { /* stamp all */ }
```

Two scope errors compounded:

1. **Wrong text.** `resumePoint` answers *"where did I stop and what do I pick up next?"*. `decisionSummary` answers *"what did THIS thread decide?"*. They are different questions about different subjects; neither is a sane default for the other.
2. **Wrong blast radius.** *Linked* is not *resolved*. `conversation_open` auto-links to the sole active session, so any thread opened mid-session was swept — including cross-team questions still awaiting an answer.

The result reads as a legitimate decision record, so nobody notices: the other party sees `decided` and stops expecting a reply. 82 threads were damaged this way before it was caught, and the field that would have shown the truth had been overwritten by the same operation.

## Business rule

A summary is scoped to the subject it describes. Never let a parent-scoped field fall through into a child-scoped one — a fallback between two different questions manufactures an answer to a question nobody asked.

Concretely:

- Closing children is **opt-in and named**, never "all linked". Reaching an entity through a link is not consent to mutate it.
- Each child closed must carry **its own** summary, supplied by the caller. If the caller cannot say what a thread decided, that thread is not resolved and must stay open.
- Do not offer a convenience "apply this summary to all of them" parameter. That is the same defect with better ergonomics — TASK-1621 removed `EndSessionInput.decisionSummary` for exactly this reason.
- Report what actually changed, not what was requested.

## Resolution

TASK-1621 replaced the sweep with `closeConversations: [{ conversationId, decisionSummary }]`, validated so each named conversation is genuinely linked to the session. Omitted, nothing closes. See the "Closing conversations" section of `mcp-rules.md`.

Still outstanding: `abandonSession` / `session_cancel` retains the sweep with `"Abandoned: <reason>"`. No `resumePoint` leak, but the same blast radius — it will keep marking unrelated open threads `decided`. Tracked as INBOX-1709.

Recovery for already-damaged threads is `conversation_reopen`, which refolds from the message log rather than re-stamping. See [[writing-conversation-header-columns-directly-is-silently-erased-by-the-fold]].
