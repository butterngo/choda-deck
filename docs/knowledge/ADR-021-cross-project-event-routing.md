---
type: decision
title: "ADR-021: Cross-Project Event Routing — Phase 3"
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-05-04
lastVerifiedAt: 2026-05-04
---

# ADR-021: Cross-Project Event Routing — Phase 3

> AI-Context: Phase 3 extends the event-emitter to route conversation events across projects. Conversation ownership stays single-project; the emitter writes the same JSONL line to every project mentioned in `roles[]` (parsed from `"projectId/workspaceId"` address strings). No schema migration. Backwards-compatible with Phase 1/2 free-form role strings — those fall through to owner project only.

## Context

Phase 1 (TASK-609) and Phase 2 (TASK-618) shipped a JSONL-based conversation event emitter. Current behavior:

- Each conversation is owned by exactly one project (`conversations.project_id`).
- Events are appended to `<CHODA_EVENT_DIR>/<projectId>.jsonl` — one file per project.
- 6 event types fire today: `message.question`, `message.answer`, `conversation.open`, `conversation.close`, `conversation.reopen`, `conversation.decide`.
- The role-filter routes events only when ≥1 participant has a non-null `participant_role`. The role string is opaque (free-form TEXT).

Butter's actual use case for the role mechanism is **workspace-to-workspace messaging**, with workspaces potentially spanning different projects:

- `automation-rule/workflow-engine` ↔ `automation-rule/remote-workflow` — same project, different workspaces
- `automation-rule/workflow-engine` ↔ `choda-deck/main` — different projects
- `automation-rule/workflow-engine` ↔ `mantu/ActivityManagement` — different projects

Phase 2 supports the same-project case via convention `role="projectId/workspaceId"` — no code change required since both participants emit/listen on the same JSONL file. Cross-project is blocked by two things:

1. The owner project's JSONL file is the only sink — listeners of other projects never see the event.
2. Conversation lookup is by `id` (works cross-project) but `conversation_list(projectId)` is per-project — a workspace cannot discover threads it participates in but doesn't own.

INBOX-047 captured this gap as a follow-up after Phase 2 shipped (PR #59, 2026-05-04).

## Options considered

| Option | Description | Pro | Con |
|---|---|---|---|
| A. Multi-project conversations | Add `conversation_projects` join table; conversation belongs to N projects | Per-project listing works directly; owner concept generalizes cleanly | Schema migration; ownership semantics ambiguous (who can close?); breaking change for `findByProject` |
| B. Global event file | One `<CHODA_EVENT_DIR>/events.jsonl`; listeners filter by `roles.includes(myAddress)` | Simplest emit (1 file always) | Every workspace reads every project's events; loses per-project isolation; tail/grep workflows break at scale |
| C. Address-aware fan-out (no schema change) | Parse `projectId` prefix from each role address; emit one JSONL line to every unique project's file (owner project always included) | Zero schema migration; reuses existing per-project files; backwards-compatible with legacy free-form roles | Same event written to N files (rare amplification when N>2); listener subscribed to multiple files would dedupe by `(conversationId, type, timestamp)` |
| D. Subscription registry | New `event_subscriptions` table; workspaces register what they listen to; emitter unicasts to subscribers' files | Decoupled; precise routing; supports filters beyond projectId | Most complex; requires registration on session start; new MCP tool surface |

## Decision

**Chosen: Option C — Address-aware fan-out, no schema change.**

The emitter parses each entry in `roles[]`. For role strings matching the format `<projectId>/<workspaceId>`, the leading segment is treated as a target project ID. The event is written to:

1. The owner project's JSONL file (always — preserves Phase 1/2 behavior for owner).
2. Every additional unique project ID parsed from `roles[]` — one JSONL line per project file.

Role strings without a `/` separator are treated as opaque labels (legacy `"FE"`, `"BE"`) and produce no additional fan-out — owner project only, identical to Phase 2.

A target project ID is validated against the `projects` table before fan-out; unknown projects are skipped with a warning. Same-line content for every file — no per-file customization (the `roles[]` array on the event body lets each listener decide which addresses concern it).

**Why this choice:** the convention `role="projectId/workspaceId"` was already established in Phase 2 without a schema change. Option C is the smallest delta that closes the cross-project gap while preserving backwards compatibility. Schema-heavier options (A, D) are over-fit to a use case the system hasn't yet stress-tested in production — start with the convention and migrate to a structured table only when fan-out duplication, ordering, or discovery become real pain.

## Why not others

| Option | Rejected because |
|---|---|
| A. Multi-project conversations | Ownership semantics (close/reopen/decide authority) become ambiguous when a conversation belongs to N projects. The migration also breaks every consumer that reads `conversations.project_id`. Worth revisiting if cross-project conversations become the dominant pattern, but not on day one |
| B. Global event file | Defeats the per-project isolation that makes a multi-project setup tractable. A workspace tailing one file to learn about its own project would now see every event from every project |
| D. Subscription registry | Premature — the system has no concrete pain that requires per-listener filters yet. The registration step also adds a session-start dependency we can avoid by parsing roles directly |

## Consequences

- **Good:** Cross-project routing with no schema migration. Phase 1/2 listeners keep working unchanged. The address convention already encouraged in Phase 2 becomes load-bearing in Phase 3, which is a clean evolution rather than a breaking change.
- **Bad:** Same event line is duplicated across N files when fan-out > 1. Listeners subscribed to multiple files (rare but possible) must dedupe by `(conversationId, type, timestamp)` — guidance to be documented in the listener-side spec.
- **Risks:**
  - **Stale projectIds:** if a role string references a project that was deleted, fan-out logs a warning and skips. No corruption, but the event is silently lost for that listener — an integration test should cover this.
  - **Fan-out cardinality:** large `roles[]` arrays (e.g., a "broadcast" conversation with 10 projects) write 10 lines per event. Acceptable today; if it becomes a hotspot, batch the writes per file in a single `appendFileSync`.
  - **Discovery still gappy:** a workspace can receive events for conversations it doesn't own, but `conversation_list(projectId)` won't return them. A Phase 3.5 follow-up may add `conversation_list_by_address(address)` or a links-based query.

## Impact

- **Files/modules changed:**
  - `src/core/domain/services/event-emitter.ts` — parse `roles[]` for `projectId/...` prefixes; expose a fan-out helper that takes the owner projectId + the target projectIds and writes once per unique target.
  - `src/core/domain/repositories/conversation-repository.ts` — `emitWithRoleFilter` calls the fan-out helper instead of `emitConversationEvent` directly. Owner projectId remains `conv.projectId`.
  - `src/core/paths.ts` — no change; `resolveEventDir` already returns a single root directory.
  - Tests: `src/core/domain/__tests__/conversation-event-emit.test.ts` adds cases for fan-out, unknown projectId, and legacy free-form role.
- **Dependencies affected:** none (still file I/O, no new packages).
- **Migration needed:** none — additive change. Existing `<projectId>.jsonl` files keep accumulating for owner-project events. Cross-project events start appearing in the addressed project files only after this change ships.

## Revisit when

- A conversation needs to genuinely belong to multiple projects (e.g., for `conversation_list` to show it across all participating projects). At that point, Option A (`conversation_projects` join table) becomes the right move.
- Listener-side dedupe becomes painful enough to justify Option D (subscription registry) — measured by a real incident or repeated developer complaint, not theory.
- Fan-out write duplication shows up in profiling (>5% of MCP latency or visible disk overhead), at which point batching or a global event file (Option B) reconsiders.

## Related

- ADR-010: Conversation Protocol — SQLite schema for conversations/participants/messages
- ADR-018: Knowledge Layer Foundation — code-coupled MD with frontmatter
- TASK-609: Event-emitter Phase 1 — `message.question` JSONL emit
- TASK-618: Event-emitter Phase 2 — 5 additional event types + `target_role` column + unified discriminator (PR #59 merged 2026-05-04)
- INBOX-047: Phase 3 cross-project routing design — origin of this ADR
- TASK-650: Phase 3 implementation task
