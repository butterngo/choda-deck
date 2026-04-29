---
type: decision
title: "ADR-015: Lifecycle Service Pattern (Composite Transactional Ops)"
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-04-19
lastVerifiedAt: 2026-04-29
---

# ADR-015: Lifecycle Service Pattern (Composite Transactional Ops)

> **Status:** ✅ Accepted
> **Trigger:** Discuss TASK-530 (`inbox_research/convert/archive` cần atomic)

---

## Context

Hiện tại MCP tool handlers đang orchestrate composite ops bằng cách gọi nhiều method facade liên tiếp **không có transaction**. Ví dụ `inbox_research` (`inbox-tools.ts:99-128`) làm 5 step: `getInbox` → validate → `findConversationsByLink` → `createConversation` → `linkConversation` → `updateInbox`.

**Hậu quả:**
- Crash giữa chừng → partial state (conversation mồ côi, inbox status sai)
- Convert có thể tạo duplicate task khi retry
- Archive có thể để conversation nửa-closed

**Vấn đề rộng hơn:** Pattern này lặp ở 4 domain — inbox, conversation, session, task lifecycle. Nếu mỗi task fix kiểu ad-hoc → mỗi nơi 1 style → khó maintain.

ADR-004 đã set foundation: `SqliteTaskService` là god-class facade compose nhiều `XxxRepository`. Đó là CRUD layer. Composite/transactional ops chưa có lớp riêng.

---

## Decision

### 1. Tách Lifecycle Service riêng cho composite ops

Mỗi domain có 2 lớp interface:

```
interfaces/
├── inbox-repository.interface.ts       # InboxOperations (CRUD)
├── inbox-lifecycle.interface.ts        # InboxLifecycleOperations (composite)
├── conversation-repository.interface.ts # ConversationOperations (CRUD)
├── conversation-lifecycle.interface.ts  # ConversationLifecycleOperations (composite)
└── ...
```

**CRUD layer** (`XxxOperations`): thin repo passthrough, 1 method = 1 table op.
**Lifecycle layer** (`XxxLifecycleOperations`): composite, transactional, multi-repo.

Implementation: `XxxLifecycleService` class riêng, nhận `db: Database` + các repo cần thiết qua constructor. `SqliteTaskService` facade compose cả 2, implement cả 2 interface.

```typescript
class SqliteTaskService implements
  TaskService,
  InboxOperations,           // CRUD
  InboxLifecycleOperations,  // composite — delegate to InboxLifecycleService
  ConversationOperations,
  ConversationLifecycleOperations,
  ...
```

### 2. Tiêu chí khi nào extract Lifecycle Service

Extract khi composite op thỏa **bất kỳ** điều kiện:

- Touch ≥2 repository
- Cần atomic guarantee (partial state risk)
- Có domain rule check trước khi mutate (status transition validation)
- ≥3 step orchestration

Nếu chỉ là 1 CRUD call + format → giữ trong tool handler. Không over-engineer.

### 3. Transaction boundary rule

**1 lifecycle method = 1 transaction = 1 `db.transaction(fn)()` call.**

Quy tắc cứng:
- Lifecycle method gọi **trực tiếp repository methods**, không gọi facade method khác → tránh nested tx (better-sqlite3 không nest cleanly, dùng savepoint phức tạp)
- Lifecycle service **KHÔNG gọi lifecycle service khác**. Cần share logic? Gọi repos trực tiếp, duplicate 1-3 dòng setup OK hơn over-abstraction.
- Repo method **không tự mở transaction** — luôn assume caller quản tx
- Nếu cần nest (rare), dùng savepoint explicit với comment giải thích

**Lý do rule "không cross-service":** Nếu Service A gọi Service B, B tự wrap tx → nested. Workaround (2-layer `_impl()` + public) thêm boilerplate cho mọi method. Cost > benefit khi shared logic chỉ vài dòng.

### 4. Error model

Throw typed Error class, **không** dùng `Result<T,E>`. Align với `typescript.md`: *"errors thrown or returned in {ok:boolean,...} shape"*.

```typescript
class InboxNotFoundError extends Error { code = 'INBOX_NOT_FOUND' }
class InboxStatusError extends Error { code = 'INBOX_INVALID_STATUS' }
class InboxConflictError extends Error { code = 'INBOX_CONFLICT' }
```

Tool layer catch theo class, format text response.

### 5. File structure

```
src/tasks/
├── sqlite-task-service.ts              # facade (compose)
├── lifecycle/
│   ├── inbox-lifecycle-service.ts
│   ├── conversation-lifecycle-service.ts
│   ├── session-lifecycle-service.ts
│   └── errors.ts                       # shared typed errors
├── interfaces/
│   ├── inbox-repository.interface.ts
│   ├── inbox-lifecycle.interface.ts
│   └── ...
└── repositories/
    └── ...
```

Lý do tách folder `lifecycle/`: SRP, file size limit (`sqlite-task-service.ts` đã 362 line, vượt hard limit 300). Nếu bolt thêm 12 lifecycle method (4 domain × 3 op) → ~700 line, không maintain được.

---

## Apply Map

| Domain | Lifecycle ops | Trigger task |
|---|---|---|
| **Inbox** | `startResearch`, `convertToTask`, `archive` | TASK-530 |
| **Conversation** | `open`, `close`, `decide`, `reopen` | TASK-533 |
| **Session** | `start` (open conv + load context), `end` (close conv + persist decisions) | TBD (M1 dogfood) |
| **Task** (future) | status transition `DONE` (cascade phase progress, close convs) | TBD |

**Insight từ Butter:** Session lifecycle cần auto-open conversation gắn session → đây chính là multi-repo composite, fit pattern này.

---

## Consequences

**Positive:**
- Atomic guarantee đúng nghĩa (transaction wrap)
- SRP: CRUD layer thuần, lifecycle layer thuần
- File size kiểm soát (mỗi service ≤200 line)
- I-segregation: consumer chỉ depend interface cần
- Pattern nhất quán across 4 domain → onboarding dễ

**Trade-offs:**
- Thêm 4 file service + 4 file interface
- Facade phải delegate qua constructor wiring (boilerplate)
- Lifecycle service phụ thuộc nhiều repo → constructor signature dài

**Out of scope:**
- Distributed transaction (single SQLite, không cần)
- Saga pattern (over-engineered cho personal tool)
- Event sourcing (ADR riêng nếu cần future)

---

## Next Steps

1. [ ] Accept ADR (Butter review)
2. [ ] TASK-530: implement `InboxLifecycleService` theo pattern này (3 method)
3. [ ] TASK-533: implement `ConversationLifecycleService` (4 method)
4. [ ] Backfill `SessionLifecycleService` khi dogfood M1 phát hiện gap
5. [ ] Update `typescript.md` rule: thêm section "Lifecycle Service Pattern"

---

## Open Questions

- [ ] Có cần shared `withTx<T>(fn)` helper không, hay inline `db.transaction(fn)()` đủ? (defer — quyết khi có ≥5 call site)
- [ ] Tool layer có cần map error code → MCP error type chuẩn, hay text response đủ?
- [ ] Lifecycle service có expose query method không, hay chỉ mutate? (đề xuất: chỉ mutate, query đi qua CRUD layer)

---

## References

- `ADR-004-sqlite-task-management.md` — SQLite + repository foundation
- `ADR-009-session-lifecycle.md` — session domain
- `ADR-010-conversation-protocol.md` — conversation domain
- `ADR-011-inbox-pipeline.md` — inbox domain
- `.claude/rules/typescript.md` — SOLID + file size limits
- better-sqlite3 transaction docs: https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md#transactionfunction---function
