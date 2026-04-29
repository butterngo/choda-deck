---
type: decision
title: "ADR-011: Inbox Pipeline — raw idea → research → task"
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-04-17
lastVerifiedAt: 2026-04-29
---

# ADR-011: Inbox Pipeline — raw idea → research → task

## Context

Butter workflow hiện tại: ý tưởng → `vault/00-Daily/inbox/` (quick capture file) → sau đó đọc lại → chuyển thành task hoặc note. Có 3 vấn đề:

1. **Inbox bị flatten** — tất cả file lẫn lộn, không track status (raw / đang research / đã convert).
2. **Không có enrichment loop** — muốn Claude "đi research ý tưởng này" thì phải copy-paste vào chat, kết quả không gắn được về item gốc.
3. **Mất trace** — khi convert thành task, không còn link ngược về inbox idea ban đầu → mất context "task này sinh ra từ đâu, đã research những gì".

Butter đề xuất workflow:

```
idea → inbox (raw)
     → worker(s) research & enrich
     → discuss/analyze (human + AI)
     → spawn task (với full research history)
     → inbox item = converted
```

ADR-010 đã định nghĩa `conversations` như first-class thread để track decision. Inbox pipeline nên **reuse** conversation system cho phần research/discuss, không tạo schema mới.

## Decision

**Inbox = lightweight queue of raw ideas. Research + discussion = conversation thread linked to inbox item. Conversion = spawn task + close conversation.**

### SQLite schema

```sql
CREATE TABLE inbox_items (
  id TEXT PRIMARY KEY,              -- INBOX-001, INBOX-002... per-project counter
  project_id TEXT,                  -- nullable (cross-cutting ideas allowed)
  content TEXT NOT NULL,            -- raw capture text
  status TEXT NOT NULL DEFAULT 'raw',
  -- raw | researching | ready | converted | archived
  linked_task_id TEXT,              -- set on convert (FK to tasks.id)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_inbox_project ON inbox_items(project_id);
CREATE INDEX idx_inbox_status ON inbox_items(project_id, status);
```

Single global counter (same table shape as `project_task_counters` for consistency, but uses one sentinel key `__all__`):

```sql
CREATE TABLE project_inbox_counters (
  project_id TEXT PRIMARY KEY,  -- always '__all__' for inbox
  last_number INTEGER NOT NULL DEFAULT 0
);
```

**Why single counter instead of per-project** (revised during implementation, 2026-04-17): Inbox IDs are the PK of `inbox_items`. Per-project counter would collide when two projects both generate INBOX-001. A single global counter keeps IDs unique and matches how real-world issue trackers work (GitHub `#42` is global within the repo, not per-label).

**Research/discussion storage** — no new tables. Use `conversation_links`:

```
conversation_links (conversation_id, linked_type='inbox', linked_id='INBOX-001')
```

One inbox item → one conversation (enforced by MCP tool, not DB constraint).

### State machine

```
raw
  → [inbox_research]   → researching
researching
  → [worker completes] → ready
  → [user cancels]     → raw
ready
  → [inbox_convert]    → converted (linked_task_id set)
  → [user rejects]     → archived
archived / converted  → terminal states (no transitions)
```

### MCP tools

| Tool | Purpose |
|---|---|
| `inbox_add(projectId?, content)` | Create INBOX-NNN, status=raw |
| `inbox_list(projectId?, status?)` | List items, filter by status |
| `inbox_get(id)` | Detail + linked conversation (if any) |
| `inbox_research(id)` | Transition to `researching`, open a conversation linked to item, return conversation ID. Subsequent research is done via `conversation_add` by worker. |
| `inbox_ready(id)` | Transition `researching` → `ready` (called by worker when research done) |
| `inbox_convert(id, taskInput)` | Create task, set `linked_task_id`, status → converted, close conversation (decision_summary = "Converted to TASK-XXX"). Atomic. |
| `inbox_archive(id)` | Status → archived. Close conversation if any. |
| `inbox_delete(id)` | Hard delete (only allowed in `raw` / `archived`). |

### UI surface in Choda Deck

New tab **Inbox** in `ViewRouter` (position 3, after Board + Terminal):

- List items filtered by project (or "All" for global).
- Each row: status badge + INBOX-NNN + content preview + age.
- Click → detail panel (reuse `deck-activity-panel` styles):
  - Full content
  - Linked conversation thread (messages + participants)
  - Action buttons: **Research**, **Convert to task**, **Archive**
- "+ Add item" input at top.

### Worker dispatch — manual first

**v1 (this ADR):** Trigger research manually — Butter calls `inbox_research` from Claude Code, which opens a conversation and expects human-in-the-loop to paste research output via `conversation_add`. No background worker yet.

**v2 (future):** Auto-dispatch — a background Claude session polls `status=raw` items, performs research (web search, codebase grep, prior-art lookup), adds findings via `conversation_add`, then calls `inbox_ready`. Requires harness engine (TASK-508).

Deferring auto-dispatch avoids complexity (auth, rate limits, idempotency) while we validate the manual workflow.

## Consequences

### Positive

- **Full trace preserved** — task spawned from inbox has `linked_task_id` back-reference via conversation_links. "Why this task?" → read the research conversation.
- **No new discussion/research schema** — conversations system already supports multi-participant, structured messages, decision recording.
- **Search across idea pipeline** — existing `search` MCP tool can grep inbox content (new table added to search union).
- **Cross-project parking lot** — `project_id` nullable enables "future ideas I haven't assigned yet" without forcing premature categorization.
- **UI is consistent** — Inbox tab reuses activity card/panel components. No new visual language.

### Negative

- **Another top-level tab** — Choda Deck main pane now has 4 tabs (Terminal, Board, Activity, Inbox) + Wiki. Risk of tab bloat. Mitigate: Inbox could eventually become a section inside Activity if list grows sparse.
- **One conversation per inbox item** enforced by tool, not DB — if buggy code bypasses MCP, could create multiple. Accept risk (single-user app).
- **Manual research in v1** — still requires Butter to paste worker output. Real automation defers to TASK-508 harness.
- **No tags/labels on inbox items** — intentionally simple. If tagging becomes needed, add later.

## Open decisions (review before build)

1. **Default `project_id` when creating via UI** — nullable (cross-cutting) or auto-fill with active project? → Proposal: auto-fill with active project, `null` only via explicit "Global inbox" toggle.
2. **INBOX counter scope** — per-project (`INBOX-001` in each project) or global (`INBOX-001` across all projects)? → Proposal: per-project (matches task ID pattern).
3. **Tab position** — after Board or after Activity? → Proposal: after Terminal, before Board (raw capture is morning-first).
4. **Convert UX** — inline form in detail panel, or switch to Board with prefilled task_create modal? → Proposal: inline (less context switch).

## Alternatives considered

- **Keep vault files** — rejected. Status tracking requires structured data, not filenames.
- **New `inbox_research` / `inbox_discussion` tables** — rejected. Duplicates conversation system; would need own participant/message/action tables.
- **Tasks with `status=inbox`** — rejected. Inbox items aren't tasks yet (no acceptance criteria, no scope). Collapsing the concepts loses the enrichment step.
- **Auto-dispatch worker in v1** — deferred. Harness engine (TASK-508) not yet built; rolling our own dispatch is premature.

## References

- ADR-008 — AI Workflow Engine Pivot (L2 conversation layer)
- ADR-010 — Conversation Protocol (the reused primitive)
- TASK-508 — Harness Engine (future auto-dispatch dependency)
