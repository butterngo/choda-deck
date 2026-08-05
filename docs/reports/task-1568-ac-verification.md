# TASK-1568 — AC verification

**Task:** Bridge: GET /conversations/:id returns conversation detail + messages
**Verified:** 2026-08-05 · session SESSION-1785908340810-28 · merge commit `6523fae` (PR #241)
**Result: 8/8 verified · 0 needing a human · 0 blocked**

## Method

Verified against the **built** `dist/companion-server.cjs` running on a **copy** of the real
database (296 conversations, real multi-participant threads) — not fixtures. The unit tests
ran separately as a gate.

## Per-criterion

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | `{conversation, messages, participants}`, domain `Conversation` | ✅ | live: all 9 conversation fields present |
| 2 | messages are domain `ConversationMessage` (`authorName`) | ✅ | live: 7 expected keys across 9 real messages |
| 3 | participants are domain `ConversationParticipant` | ✅ | live: 3 real participants, `{conversationId, name}` |
| 4 | oldest-first + content byte-identical | ✅ | createdAt sequence equals its own sort; capture markdown round-tripped verbatim |
| 5 | unknown id → 404 JSON | ✅ | `{"error":"unknown conversation: CONV-does-not-exist"}` |
| 6 | list route unchanged | ✅ | live: `{conversations:[...]}`, 296 rows |
| 7 | POST → 405 | ✅ | live |
| 8 | diff confined to `src/adapters/companion/**` | ✅ | `git show --stat 6523fae` |

## End-to-end proof

The three merged subtasks were exercised as one chain against the live-shaped DB:

```
POST /capture  kind=image destination=conversation
  → {"id":"CONV-1785908325689-1","destination":"conversation"}

GET /conversations/CONV-1785908325689-1
  → message content: "![capture](captures/14211d9cfb7af811.png)\n\n(70 bytes)\n\nSource: …"

GET /artifacts/captures/14211d9cfb7af811.png
  → HTTP 200  type=image/png  bytes=70
```

Capture → conversation → relative path → artifact bytes. TASK-1566, TASK-1567 and TASK-1568
compose; what remains for the feature is purely the web-side rendering (TASK-1569/1570).

## Findings

**The task's own acceptance criteria named two fields that do not exist.**
As written, AC-1 specified `messages[].author` and `participants[].role`. The real domain
types are `ConversationMessage.authorName` (`task-types.ts:297`) and
`ConversationParticipant.{conversationId, name}` (`:287`) — there is no `role` at all. The
criteria had been written from memory rather than read off the type.

Caught before implementation, while the body was still unlocked, and corrected in the task
body with the reason recorded. The alternative — adding a rename layer in the route to make
the wrong criterion pass — would have introduced a mapping no other companion read route
has (`task-detail.ts:31` passes domain objects straight through) purely to protect a
mistake in the spec.

Worth noting because the mistake was invisible until someone opened the type: the criterion
was specific, testable, and confidently wrong.

## Gates

| Gate | Result |
|---|---|
| `pnpm run typecheck` | clean |
| `pnpm test` | 132 files / 1600 passed / 1 todo |
| `pnpm run lint` | clean |
| `pnpm run build:companion` | clean |
| CI (ubuntu + windows) | both pass |
| Merge proof | `6523fae` is an ancestor of `origin/main` |
