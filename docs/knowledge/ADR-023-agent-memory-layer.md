---
type: decision
title: "ADR-023: Agent memory layer — 2-tier episodic + procedural với Letta self-edit distillation"
projectId: choda-deck
scope: project
refs:
  - path: src/core/domain/repositories/schema.ts
    commitSha: e4ce1f3cc8d274adfbf66fa352f8ab5a443412f4
  - path: src/core/domain/task-types.ts
    commitSha: e4ce1f3cc8d274adfbf66fa352f8ab5a443412f4
  - path: src/adapters/mcp/server.ts
    commitSha: e4ce1f3cc8d274adfbf66fa352f8ab5a443412f4
  - path: src/adapters/mcp/mcp-tools/session-tools.ts
    commitSha: e4ce1f3cc8d274adfbf66fa352f8ab5a443412f4
  - path: src/core/domain/interfaces/session-lifecycle.interface.ts
    commitSha: e4ce1f3cc8d274adfbf66fa352f8ab5a443412f4
  - path: src/core/domain/interfaces/session-repository.interface.ts
    commitSha: e4ce1f3cc8d274adfbf66fa352f8ab5a443412f4
  - path: docs/knowledge/ADR-009-session-lifecycle.md
    commitSha: e4ce1f3cc8d274adfbf66fa352f8ab5a443412f4
  - path: docs/knowledge/ADR-018-knowledge-layer.md
    commitSha: e4ce1f3cc8d274adfbf66fa352f8ab5a443412f4
  - path: docs/knowledge/ADR-020-embedding-architecture.md
    commitSha: e4ce1f3cc8d274adfbf66fa352f8ab5a443412f4
createdAt: 2026-05-16
lastVerifiedAt: 2026-05-18
---

# ADR-023: Agent memory layer — 2-tier episodic + procedural với Letta self-edit distillation

> AI-Context: choda-deck thêm 2-tier memory layer (raw session events + distilled cross-session memories) để agent recall được bài học cũ ở session sau. Self-edit tại session_end. Bridge tới ADR knowledge khi memory load-bearing.

## Status (as of 2026-05-18)

| Phase | Scope | Status |
|---|---|---|
| Phase 1 | Schema (`session_events`, `agent_memories`) + 5 MCP tools (`session_event_add`, `session_event_list`, `memory_write`, `memory_recall`, `memory_promote_to_knowledge`) | ✅ shipped |
| Phase 2 | `session_end` self-edit prompt — `endSession` returns `memoryCandidates` (events flagged `memory_candidate=1`) + `selfEditPrompt` instructing the agent to call `memory_write` for 1-3 distilled entries; forwarded through `task_approve` / `task_reject` composites | ✅ shipped (PR #117, TASK-827) |
| Phase 3 | `session_start` auto-recall — `StartSessionResult` gains `recalledMemories: AgentMemory[]` populated by scope-match (task → workspace → project), ranked by importance; `recallCount` + `lastRecalledAt` bumped automatically | ✅ shipped (TASK-846) |
| Phase 4 | Promotion path tool + recall analytics ("which memories get recalled most") | ⏳ partial — `memory_promote_to_knowledge` tool ships, analytics surface not built |

Phases 1–3 are complete: the memory layer is now "free at the boundaries" — `session_start` surfaces prior memories automatically and `session_end` nudges the agent to distill new ones. Phase 3 omits the `user` scope (StartSessionInput has no `userId`); user-scoped memories must still be reached via explicit `memory_recall`. Phase 4 covers promotion analytics (recall frequency) and an auto-promote path for high-recall memories.

## Context

Hiện tại sessions chỉ giữ `handoff` (terminal summary, fixed shape) + `checkpoint` (mutable snapshot). Mất nguyên timeline trong session — không reconstruct được "đã đụng AC nào, sửa file gì, quyết định gì". Quan trọng hơn: agent KHÔNG nhớ bài học cross-session — mỗi session start lại từ tabula rasa, lặp lại bug + pattern đã giải quyết.

Concept "agent memory" 2026 (Letta, Mem0): agent cần episodic (chuyện gì đã xảy ra) + procedural (cách làm việc trong codebase này) memory, retrievable theo scope, để inform session sau. Ecosystem Butter đã có semantic memory (`knowledge_*` ADRs, `vault/30-Knowledge/`) và procedural cá nhân (`.claude/.../memory/feedback_*`), nhưng thiếu episodic + project-procedural.

## Options considered

| Option | Pro | Con |
|---|---|---|
| A. Forensic audit log (1 bảng `session_events`) | KISS, dễ build, đủ debug | Không phải memory — không retrievable cross-session, agent vẫn quên bài học |
| B. Mem0-style passive extraction | Tự động, không phụ thuộc Claude rành mạch | Spam memory (50+/session), đa số noise, lock vào extraction algorithm |
| C. Letta-style 2-tier self-edit | Cross-session retrievable, Claude tự chọn 1-3/session cốt lõi, có promotion path lên ADR | Phụ thuộc Claude self-discipline; schema phức tạp hơn (2 bảng + scope hierarchy) |
| D. Mở rộng `handoff_json` thành memory | Không cần bảng mới | Handoff kẹt trong row session, không cross-session query, không rank, fixed shape — bottleneck cũ |

## Decision

**Chosen: Option C — Letta-style 2-tier self-edit**

Tier 1 (`session_events`): append-only raw timeline trong session, nguyên liệu thô. Tier 2 (`agent_memories`): cross-session, scoped (user/project/workspace/task), ranked theo importance + recall_count. Tại `session_end` Claude self-edit 1-3 memory entries có giá trị từ events. Tại `session_start` auto-recall top-N theo scope match. Promotion path: memory load-bearing → ADR.

Judgment quality của Claude > volume của passive extraction. Tách 2 tier để tách concern (raw log vs distilled knowledge). Scope hierarchy 4 mức để retrieval merge từ specific → general theo Mem0 pattern.

## Why not others

| Option | Rejected because |
|---|---|
| A. Forensic audit log | Misframed — solve sai vấn đề; agent vẫn không recall được; chỉ là log, không phải memory |
| B. Mem0 passive extraction | Spam noise, lock vào algorithm, không tận dụng được judgment của Claude. Thêm external dependency không cần |
| D. Mở rộng handoff | Kẹt cứng cardinality 1:1 với session, không scale retrieval khi có 100+ sessions; fixed shape không cover procedural memory |

## Consequences

- **Good:**
  - Agent bắt đầu mỗi session với memory liên quan đã load → giảm lặp bug cũ, tăng consistency cross-session
  - Episodic gắn task scope = chi tiết không nhiễu; procedural project scope = luật chung tự nổi lên qua recall_count
  - Promotion path tạo natural pipeline: organic learning → formal ADR → memory deprecate
  - Mở đường cho embeddings sau khi data đủ + biết miss pattern thực tế
- **Bad:**
  - Phải sửa `session_start` (response signature thêm `recalledMemories`) và `session_end` (prompt Claude self-edit) — breaking change cho integrators
  - 2 bảng + 5 MCP tool mới → surface area tăng
  - Phụ thuộc Claude self-edit kỷ luật; spam hoặc viết lười đều giảm giá trị
- **Risks:**
  - **Memory bloat**: Claude self-edit không nghiêm → recall noise. Mitigate: cap 1-3/session, importance decay theo recall_count thấp + age
  - **Scope mismatch**: ghi nhầm scope → recall sai context. Mitigate: tool description rõ ranh giới từng mức scope
  - **Retrieval quality plateau**: tags + LIKE search hạn chế ngữ nghĩa. Mitigate: D3 đã tách phase — thêm embeddings (theo [[ADR-020-embedding-architecture]]) khi miss-rate cao
  - **Trùng layer với existing memory**: confusion giữa `feedback_*`, `knowledge_*`, `agent_memories`. Mitigate: doc ranh giới — feedback = cross-project cá nhân, knowledge = formal cross-project, agent_memories = project-bound organic

## Impact

- **Files/modules changed:**
  - `src/core/domain/repositories/schema.ts` — 2 bảng mới (`session_events`, `agent_memories`) + indexes
  - `src/core/domain/repositories/` — thêm `session-event-repository.ts`, `agent-memory-repository.ts`
  - `src/core/domain/task-types.ts` — types mới (`SessionEvent`, `AgentMemory`, scope enums)
  - `src/adapters/mcp/mcp-tools/` — 5 file mới: `session-event-add.ts`, `session-event-list.ts`, `memory-write.ts`, `memory-recall.ts`, `memory-promote-to-knowledge.ts`
  - `src/adapters/mcp/server.ts` — register 5 tool mới
  - `src/adapters/mcp/mcp-tools/session-tools.ts` — Phase 2/3: update `session_start` response (add `recalledMemories`) + `session_end` prompt (instruct self-edit)
- **Dependencies affected:** none (better-sqlite3 + existing repository pattern)
- **Migration needed:** Yes — schema bump cộng new tables, forward-only (tables start empty, no data migration). Rollout 4 phase:
  - Phase 1: schema + 5 tools (no session_start/end integration) — gọi tay để smoke
  - Phase 2: integrate `session_end` self-edit prompt
  - Phase 3: integrate `session_start` auto-recall
  - Phase 4: promotion path tool + analytics (which memories get recalled most)

## Revisit when

- Memory recall miss-rate Butter báo cao (cần memory mà không recall ra) → đánh giá thêm embedding theo [[ADR-020-embedding-architecture]] pattern
- Bảng `agent_memories` quá 5000 rows/project hoặc query > 50ms → consider partitioning hoặc archival vào artifacts
- Self-edit fail mode rõ (Claude consistently quên hoặc spam) → cân nhắc Mem0-style passive fallback cho 1 số event type cụ thể
- [[ADR-009-session-lifecycle]] thay đổi đáng kể (vd đổi session model) → tái thẩm vì tier 2 hook vào session_start/end
- Multi-agent scenario (Copilot agent ngoài Claude) → mở rộng `scope_type` thêm `agent_id` để cách ly memory per agent

## Related

- Builds on: [[ADR-009-session-lifecycle]] — sessions là container sinh memory; tier 2 hook vào session_start/end
- Builds on: [[ADR-018-knowledge-layer]] — knowledge layer là đích của promotion path
- Complements: [[ADR-020-embedding-architecture]] — defer embeddings sang Phase 5+, sẽ tái dùng pattern này khi promote retrieval
- Boundary với: `~/.claude/projects/.../memory/feedback_*` (cross-project cá nhân) — agent_memories là project-bound, KHÔNG đụng layer này
- Origin conversation: `CONV-1778943201405-9` (decided 2026-05-16), supersedes `CONV-1778940980564-6` (closed — misframed forensic audit)
