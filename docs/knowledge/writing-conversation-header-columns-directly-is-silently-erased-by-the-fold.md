---
type: gotcha
title: Writing conversation header columns directly is silently erased by the fold
projectId: choda-deck
scope: project
refs:
  - path: src/core/domain/repositories/conversation-repository.ts
    commitSha: 29e4551e69996b805723960e2ca271ce3c860623
  - path: src/core/domain/lifecycle/session-lifecycle-service.ts
    commitSha: 29e4551e69996b805723960e2ca271ce3c860623
  - path: src/core/domain/lifecycle/conversation-lifecycle-service.ts
    commitSha: 29e4551e69996b805723960e2ca271ce3c860623
  - path: src/core/domain/lifecycle/inbox-lifecycle-service.ts
    commitSha: 29e4551e69996b805723960e2ca271ce3c860623
createdAt: 2026-08-10
lastVerifiedAt: 2026-08-10
affectedFeatureId: feature-conversation-protocol
---

## Trigger

You close or decide a conversation by calling `conversations.update(id, { status: 'decided', decisionSummary, decidedAt })`, it looks correct in the database, and then it reverts — or a test asserting the new state passes in isolation and fails once anything else touches the thread.

## Context

Since TASK-1067 the conversation header — `status`, `decision_summary`, `signed_off_json`, `decided_at` — is **not authoritative state**. It is a cache, derived by `ConversationRepository.recomputeHeader` as a pure fold over the append-only `conversation_messages` log:

- `status` = `decided` only when a `kind='decision'` turn exists **and** every registered participant has a `kind='signoff'` turn
- `decision_summary` = the content of the **last** `decision` turn, else `NULL`
- `decided_at` = the latest timestamp among the decision turn and the signoffs

The fold is deliberately pure so it converges on any node after a sync merge, regardless of last-writer-wins on the (non-authoritative) header columns. `sync-pull.ts` and `sync-sink.ts` both re-run it over affected conversations.

## Business rule

A header value that no message backs is not durable state — it is a lie with a short half-life. Any subsequent `recomputeHeader` (a new turn, a sync merge, a manual refold) recomputes from the log and wipes it, with no error and no warning.

So: **never write the header cache columns to express a decision.** Append the typed turn and refold.

```ts
// wrong — survives until the next fold, then vanishes
this.conversations.update(conv.id, { status: 'decided', decisionSummary, decidedAt })

// right — the log is the source of truth; the header follows
this.conversations.addMessage({
  conversationId: conv.id, authorName, content: decisionSummary, kind: 'decision'
})
this.conversations.recomputeHeader(conv.id)
```

Corollary: after refolding, **re-read** before reporting what happened. The fold withholds `decided` until every participant has signed off, so "I appended a decision turn" does not imply "the thread is now closed".

## Resolution

TASK-1621 hit this in `session_end`, which was still writing the header directly. The repro test made it visible: the assertion passed immediately after the write, then `recomputeHeader` returned `status: 'open'` — proving the write was unbacked. Fixed by routing the close through a `decision` turn plus a refold.

`InboxLifecycleService.closeLinkedConversations` (`inbox-lifecycle-service.ts`) still writes the header directly and carries the same latent defect. It has not bitten yet because nothing refolds those threads afterwards, but it is the same shape.
