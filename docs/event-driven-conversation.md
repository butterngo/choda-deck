# Event-driven conversation handoff

Phase 1 scope. Lets a long-running Claude Code session (e.g. "BE") wake up
and reply as soon as someone asks it a question in a `choda-tasks` conversation —
no polling, warm context, zero idle cost.

## How it works

1. A conversation in choda-tasks has at least one participant with a role
   (`FE`, `BE`, `QA`, `PM`, …).
2. When any caller invokes `conversation_add` with `messageType=question`,
   `ConversationRepository.addMessage` appends a single line to
   `<CHODA_EVENT_DIR>/<projectId>.jsonl`:

   ```json
   {"conversationId":"CONV-abc","roles":["BE"],"messageType":"question","author":"FE","timestamp":"2026-04-24 10:00:00"}
   ```

3. A BE-role Claude Code session runs once:

   ```
   /loop tail new events from C:\Users\<you>\AppData\Local\Temp\choda-events\automation-rule.jsonl; when a new line appears, read the referenced conversation (conversation_read) and reply via conversation_add as BE based on the codebase
   ```

   Claude Code arms its Monitor tool to tail the file. When a new line
   appears, Claude wakes in the same session (warm context, prompt cache
   preserved), reads the conversation, and posts an answer.

## Configuration

| Env var          | Default                                   | Purpose                          |
| ---------------- | ----------------------------------------- | -------------------------------- |
| `CHODA_EVENT_DIR` | `<os.tmpdir()>/choda-events`              | Directory for per-project JSONL |

Per-project file: `<CHODA_EVENT_DIR>/<projectId>.jsonl`.

Directory is auto-created on first emit. Event append is fire-and-forget:
I/O errors are logged but never block the DB insert.

## Emit rules

The emitter only fires when **both** conditions hold:

- `messageType === 'question'`, AND
- the conversation has at least one participant with a non-null `role`.

Non-question messages (`answer`, `comment`, `proposal`, …) are never emitted,
and conversations where nobody has a role are treated as human-only — no event.

## Event shape

```ts
interface ConversationEvent {
  conversationId: string
  roles: string[]       // all participants with role != null, alphabetically unsorted
  messageType: string   // always 'question' in phase 1
  author: string        // the message's authorName
  timestamp: string     // createdAt from the DB row
}
```

## Canonical `/loop` prompt

Copy into a dedicated Claude Code session that owns the BE role:

```
/loop tail new events from <CHODA_EVENT_DIR>/<projectId>.jsonl; when a new line
arrives, read the referenced conversation and reply as BE based on the codebase
```

Be explicit with "tail" / "Monitor" — otherwise Claude may fall back to
fixed-interval polling.

## Out of scope (future phases)

- Task / session / inbox events
- Dedup at emit (caller filters duplicates by `conversationId` + timestamp)
- `targetRole` column on messages (explicit message routing)
- UI indicator for the event stream
- A matching FE-side loop that waits for `messageType=answer`
