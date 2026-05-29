---
type: decision
title: "ADR-024: REVIEW task status + session checkpoint-on-finish cho queue runner"
projectId: choda-deck
scope: project
refs:
  - path: src/core/domain/task-types.ts
    commitSha: 43ec7295d81aab5dbf1394838b238badd3a4d921
  - path: src/core/domain/lifecycle/queue-lifecycle-service.ts
    commitSha: 43ec7295d81aab5dbf1394838b238badd3a4d921
  - path: src/core/domain/lifecycle/session-lifecycle-service.ts
    commitSha: 43ec7295d81aab5dbf1394838b238badd3a4d921
  - path: src/core/domain/interfaces/session-lifecycle.interface.ts
    commitSha: 43ec7295d81aab5dbf1394838b238badd3a4d921
  - path: docs/knowledge/ADR-009-session-lifecycle.md
    commitSha: 43ec7295d81aab5dbf1394838b238badd3a4d921
  - path: docs/knowledge/ADR-019-autonomous-queue-runner.md
    commitSha: 43ec7295d81aab5dbf1394838b238badd3a4d921
status: superseded
createdAt: 2026-05-17
lastVerifiedAt: 2026-05-29
---

# ADR-024: REVIEW task status + session checkpoint-on-finish cho queue runner

> **Status (2026-05-29): SUPERSEDED by TASK-982 — queue runner subsystem removed.**
> The `REVIEW` task status was removed from the `TaskStatus` union; `task_approve`/`task_reject`
> MCP tools, `TaskReviewLifecycleService`, and the queue-runner checkpoint fields
> (`outcome`, `diffPath`, `claudeJsonPath`, `acLogPath`, `costUsd`, `numTurns`, `awaitingReview`,
> `reviewOutcome`, `reviewReason`) were all deleted. Backup branch: `origin/archive/queue-runner`
> at `45ef97c`. See ADR-019 supersession note for the wider rationale.

> AI-Context: Thêm status `REVIEW` giữa `IN-PROGRESS` và `DONE`. Queue runner kết thúc một task không còn `endSession` — chuyển sang `checkpointSession` và đẩy task sang `REVIEW` (cả pass lẫn fail). Session chỉ thật sự `endSession` khi reviewer approve (→ `DONE`) hoặc reject (→ `IN-PROGRESS`). Reviewer recall session qua link `task.id ↔ session.taskId` sẵn có.

## Context

Hiện tại `TaskStatus = 'TODO' | 'READY' | 'IN-PROGRESS' | 'DONE' | 'CANCELLED'` ([[task-types.ts]]). Queue runner ([[ADR-019-autonomous-queue-runner]]) khi chạy xong một task:

- AC pass + cost cap OK → `endSession` với handoff `"auto-completed by queue runner"` + task → `DONE` (qua `failTask` ngược lại với DONE path)
- AC fail / cost cap / spawn error → `failTask` → `abandonSession` hoặc tương tự, task vẫn IN-PROGRESS với reason note

Hệ quả:

1. `DONE` mang nghĩa nhập nhằng — "Claude ghi diff xong" chứ không phải "đã review, ship được". Reviewer phải tự suy ra task nào đáng review.
2. Session đóng ngay khi queue xong → reviewer pick up sau không có handle session để xem timeline + decisions. Phải đào artifact (`diff.patch`, `claude.json`, `ac-log.txt`) thủ công.
3. Task fail trong queue rơi vào trạng thái lửng (`IN-PROGRESS` + reason note) — không tách bạch với task đang chạy.

Concept "review gate" là standard trong CI/CD (PR review trước khi merge), và `session_checkpoint` đã có sẵn ([[ADR-009-session-lifecycle]] line 152 `session-lifecycle-service.ts`) — chỉ chạy được khi session `active`, tức là design cho phép giữ session sống qua nhiều "milestone". Đây là cơ hội tái dùng primitive đã có thay vì tạo concept mới.

## Options considered

| Option | Pro | Con |
|---|---|---|
| A. Giữ nguyên (status quo) | Zero change | Reviewer mù context, DONE nhập nhằng, fail lửng |
| B. REVIEW giữa IN-PROGRESS và DONE + checkpoint thay endSession | Status flow tường minh, reviewer có session sống để recall, dùng primitive sẵn có | Breaking semantic của `DONE`, cần MCP tool mới (approve/reject), session "treo" lâu hơn |
| C. REVIEW song song (optional flag), DONE giữ ý nghĩa cũ | Backward-compatible cho task không cần review | 2 cơ chế song song, edge case nhiều, không giải quyết được vấn đề "session đóng sớm" — vẫn cần checkpoint riêng |
| D. Chỉ checkpoint, không thêm status | Đỡ schema change | Không có signal rõ "task chờ review" — reviewer vẫn phải scan thủ công |

## Decision

**Chosen: Option B — REVIEW status giữa IN-PROGRESS và DONE + queue checkpoint-on-finish**

### Status flow

```
TODO → READY → IN-PROGRESS → REVIEW → DONE
                    ↑           │
                    └───────────┘  (reviewer reject)
```

- `DONE` đổi nghĩa: "đã review approve, ship được" (không phải "Claude ghi diff xong")
- `REVIEW` mang nghĩa: "queue đã chạy xong (pass hoặc fail), chờ con người verdict"
- Reject từ REVIEW → quay về `IN-PROGRESS` (không phải READY) — giữ tinh thần "task đang dang dở"
- Không thêm `FAILED` status — fail từ queue cũng vào `REVIEW`, reviewer triage

### Session lifecycle thay đổi

| Event | Trước | Sau |
|---|---|---|
| Queue task pass | `endSession` + task→DONE | `checkpointSession` + task→REVIEW |
| Queue task fail (AC/cost/spawn) | `abandonSession` + task ở IN-PROGRESS | `checkpointSession` + task→REVIEW (với reason trong checkpoint) |
| Reviewer approve | — (mới) | `endSession` (handoff: approved) + task→DONE |
| Reviewer reject | — (mới) | `endSession` (handoff: rejected, reason) + task→IN-PROGRESS |

### Checkpoint payload (queue)

`CheckpointSessionInput.checkpoint` ghi nhận:
- `outcome`: `'pass'` | `'fail'`
- `reason`: lý do fail (nếu có)
- `diffPath`, `claudeJsonPath`, `acLogPath`: pointer tới artifact để reviewer recall
- `costUsd`, `numTurns`: metrics
- `awaitingReview: true` flag

### Session ↔ task linkage cho reviewer

Đã có sẵn: `session.taskId` (tham số `startSession`). Reviewer query `session_list --task <id> --status active` để lấy session đang chờ. Không cần thêm cột.

### MCP tool surface

Thêm 2 tool:
- `task_approve(taskId, note?)` → composite: `endSession` (handoff=approved) + `task_update` status=DONE
- `task_reject(taskId, reason)` → composite: `endSession` (handoff=rejected+reason) + `task_update` status=IN-PROGRESS

Không extend `task_update` để giữ tách bạch — approve/reject là composite ops, không phải status edit thuần.

### Migration

Task `DONE` cũ giữ nguyên ý nghĩa cũ (Claude ghi xong). KHÔNG backfill về REVIEW — sẽ nhiễu lịch sử. Chỉ áp dụng từ task chạy queue sau khi ADR này ship.

## Why not others

| Option | Rejected because |
|---|---|
| A. Status quo | Không giải quyết 3 vấn đề đã liệt kê trong Context |
| C. REVIEW optional song song | 2 cơ chế đồng tồn tại → ambiguity trong code path, vẫn cần fix session-đóng-sớm riêng, không đỡ được công gì so với B |
| D. Chỉ checkpoint | Reviewer vẫn không có signal rõ task nào chờ — query `session_list active` không phân biệt được "đang chạy" vs "chờ review". Cần status để UI/CLI filter |

## Consequences

- **Good:**
  - Reviewer có session active + artifact pointer trong checkpoint → recall nhanh context (cost, AC kết quả, diff)
  - `DONE` đổi nghĩa thành "ship-ready" → phù hợp với mental model "task xong = đã review"
  - Fail từ queue có đường ra rõ (→ REVIEW) thay vì kẹt IN-PROGRESS
  - Tái dùng `checkpointSession` đã có → không cần primitive mới
  - Mở đường cho automation review sau này (vd Copilot agent review qua [[conversation_open]])
- **Bad:**
  - Breaking semantic của `DONE` — tool consumer cũ (CLI report, `stats_report`, `roadmap`) cần audit xem có chỗ nào đếm "DONE" làm proxy cho "queue success" không. Nếu có → đổi sang đếm `DONE + REVIEW`
  - Session "treo" trong REVIEW → metric "session duration" sẽ tăng (cần exclude REVIEW từ active-time analytics)
  - Thêm 2 MCP tool → surface area tăng
  - Queue test fixtures + lifecycle tests phải cập nhật (queue-start-lifecycle.test.ts, queue-lifecycle-service.test.ts)
- **Risks:**
  - **REVIEW backlog**: nếu Butter không review kịp, REVIEW pile up + session active pile up → quá nhiều session row active. Mitigate: thêm metric `pendingReviewCount` vào `stats_report` để Butter thấy; cân nhắc auto-timeout REVIEW → CANCELLED sau N ngày (defer Phase 2)
  - **Reject loop**: reviewer reject → IN-PROGRESS → queue pick lại → REVIEW → reject lại. Mitigate: queue runner check task hiện tại đã có session bị reject gần đây thì skip (defer Phase 2 nếu xảy ra thực tế)
  - **Composite tool atomicity**: `task_approve` = endSession + task_update. Nếu một bước fail giữa chừng → trạng thái lệch. Mitigate: wrap trong DB transaction tại lifecycle service (pattern [[ADR-015-lifecycle-service-pattern]])

## Impact

- **Files/modules changed:**
  - `src/core/domain/task-types.ts` — thêm `'REVIEW'` vào `TaskStatus` union + `TASK_STATUSES` array
  - `src/core/domain/lifecycle/queue-lifecycle-service.ts` — thay `endSession`/`abandonSession` bằng `checkpointSession`, task→REVIEW (cả 2 nhánh main flow line ~379-521 và preflight flow line ~747-916)
  - `src/core/domain/lifecycle/queue-lifecycle-service.ts` — `failTask` rename/refactor: không còn marks IN-PROGRESS, marks REVIEW với checkpoint chứa reason
  - `src/core/domain/lifecycle/` — thêm `task-review-lifecycle-service.ts` chứa `approveTask` + `rejectTask` (composite ops)
  - `src/adapters/mcp/mcp-tools/` — thêm `task-approve.ts`, `task-reject.ts`
  - `src/adapters/mcp/server.ts` — register 2 tool mới
  - Tests: `queue-lifecycle-service.test.ts`, `queue-start-lifecycle.test.ts` cập nhật assertions; thêm `task-review-lifecycle-service.test.ts`
- **Dependencies affected:** none
- **Migration needed:** Schema không đổi (TaskStatus chỉ validate ở TS layer, không có DB CHECK constraint — đã verify `schema.ts:54`). Forward-only — task DONE cũ không backfill.

## Revisit when

- REVIEW backlog vượt 20 task/project liên tục → cần auto-timeout hoặc batch-review UI
- Reject loop xảy ra (cùng task được reject 2+ lần) → cần queue-side check trước khi pick task có session bị reject gần đây
- Multi-reviewer scenario (Copilot agent + Butter review song song) → cần `reviewer_id` trên approve/reject để track
- [[ADR-009-session-lifecycle]] đổi model session đáng kể → tái thẩm vì REVIEW status couple chặt với session active state
- Metric "session active duration" trở thành KPI → exclude REVIEW phase khỏi tính toán

## Related

- Builds on: [[ADR-009-session-lifecycle]] — REVIEW reuse `checkpointSession` primitive
- Builds on: [[ADR-019-autonomous-queue-runner]] — thay đổi per-task lifecycle của queue runner
- Builds on: [[ADR-015-lifecycle-service-pattern]] — composite approve/reject thuộc lifecycle service, không phải MCP tool handler
- Complements: [[ADR-023-agent-memory-layer]] — session_events tier 1 sẽ ghi lại reviewer verdict cho cross-session learning (defer Phase 2)
- Boundary với: PR/review trên GitHub — ADR này chỉ govern review trong choda-tasks; PR review (qua `/ultrareview` hoặc thủ công) là layer riêng, không thay thế lẫn nhau
