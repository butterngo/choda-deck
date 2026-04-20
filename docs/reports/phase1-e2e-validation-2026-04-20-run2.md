# Phase 1 E2E Validation — Run 2, 2026-04-20

**Task:** TASK-544 — E2E Phase 1 validation
**Session:** SESSION-1776697545757-3
**Pipeline session:** SESSION-1776697763364-5 (aborted after approval)
**Precedent:** [Run 1](phase1-e2e-validation-2026-04-20.md) — iterate decision, discovered F1 + F2.
**Verdict:** **Path A (happy) validated — proceed to Phase 2 Generator.**

## Setup

- Branch: `main` @ 93cc2fb (TASK-556 R3 guard fix merged via PR #23; TASK-557 diagnostics via PR #22)
- MCP bundle rebuilt post-merge (`dist/mcp-server.cjs` mtime 22:06, commit timestamp 22:03)
- `/mcp reconnect` executed before smoke test
- Task picked for pipeline: **TASK-532** (Move vault-importer out of src/tasks/) — same as Run 1, smallest scope

## Run log

### 1. TASK-556 forward guard verification

1. `session_start` produced `CONV-1776697545757-4`. But because this was created *before* the MCP rebuild, it still has `owner_type=NULL` — legacy state.
2. First `pipeline_start TASK-532 evaluator=off` → **succeeded** (session created, stage=running). This confirmed that a NULL-tagged conv does not block. No surprise.
3. Aborted the unblocked pipeline.
4. `conversation_open` (fresh new-bundle write) created `CONV-1776697717024-2` tagged `owner_type='interactive'` (confirmed via direct DB read).
5. `pipeline_start TASK-532` on top of that interactive conv → **error**:

   ```
   {
     "code": "INTERACTIVE_CONV_BLOCKING",
     "message_vi": "Đang có hội thoại tương tác trong project này. Kết thúc trước khi start pipeline.",
     "payload": {
       "owner_type": "interactive",
       "owner_session_id": null,
       "owner_task_id": null,
       "started_at": "2026-04-20 15:08:37"
     }
   }
   ```

   ✅ TASK-556 forward direction verified live end-to-end through MCP.

### 2. Planner + approval path (Path A)

1. Closed blocker conv (`conversation_decide` → `conversation_close`).
2. `pipeline_start TASK-532 evaluator=off` → SESSION-1776697763364-5, stage=plan/running.
3. Waited ~75 s → stage flipped to `plan/ready`. (Run 1 baseline: ~30 s to failure; Run 2: ~75 s to ready.)
4. Read `data/artifacts/SESSION-1776697763364-5/plan.json` — 4.7 KB, well-structured:
   - 6 files with per-file action + rationale
   - 9 sequential steps with detail text
   - 5 risks with mitigations
   - 8 dependencies (tasks, files, tools, external)
5. `pipeline_approve` → stage advanced to `generate/running`.
6. DB check on `pipeline_approvals`:
   ```
   session_id=SESSION-1776697763364-5, stage=plan, iteration=0,
   decision=approve, feedback=NULL, diagnostics=NULL, created_at=2026-04-20 15:12:34
   ```
7. `pipeline_abort` — generate stage has no Generator implementation yet; no way to reach `done` in Phase 1.

### 3. TASK-557 diagnostics — NOT exercised live

Planner succeeded this run (unlike Run 1), so `planner-failure.json` was never written. Unit tests cover the shape (+6 tests in PR #22); live exercise remains pending on the next planner failure.

## Findings

### F5 — plan.md not written (acceptance gap, minor)

TASK-544 acceptance lists `artifacts/<session>/plan.{json,md}` but `writePlanArtifact` (src/core/harness/artifacts.ts) only emits `plan.json`. PlanViewer (Phase 3 UI) renders from JSON directly, so user-facing rendering works — but the acceptance spec checkbox is technically unsatisfied.

Options: (a) emit plan.md alongside plan.json for git-diff-friendly review; (b) correct the acceptance spec. Recommend (a) — cheap, one utility function, helps manual review without opening the app.

→ Candidate for a small follow-up task (low priority).

### F6 — `generate` stage has no runner in Phase 1 (expected, but spec mismatch)

Approving `plan` moves state to `generate/running`, but ADR-014 Phase 1 explicitly defers Generator. The session is stuck at `generate/running` until manually aborted. TASK-544 acceptance line *"Approval → stage='done' (Phase 1 có 1 stage nên approve = finalize)"* is incorrect — the state machine has always been plan→generate→(evaluate?)→done.

Not a bug — the state machine is correct; the task body assumption was wrong. For Phase 1 validation we interpret "approval flow works" = `plan/ready → plan approved → stage advances & approval row persisted`, which passed.

→ Update task body on close, not a code change.

### F1 & F2 from Run 1 — resolved

- F1 (R3 guard gap) → TASK-556 shipped PR #23, verified live (§1 above).
- F2 (planner silent failure) → TASK-557 shipped PR #22, unit-tested; live exercise pending next planner failure.

### Legacy NULL-tagged conversations

`CONV-1776697545757-4` (from `session_start` before the MCP rebuild) is still open with `owner_type=NULL`. It is invisible to the guard by design — no backfill migration shipped (see TASK-556 PR decision). Future sessions will tag properly. Not an action item.

## Acceptance checklist (TASK-544)

- [x] Plan.md readable, actionable — plan.json is structured and actionable; plan.md gap noted in F5.
- [x] Notification arrive trong <2 min — 75 s to `plan/ready`.
- [~] Approval → `stage='done'` — **partial.** Approval advances state machine correctly; `done` requires Generator (Phase 2). See F6.
- [x] R3 guard: mở interactive conv rồi `pipeline_start` → rejected with correct payload. ✓
- [~] Artifact layout `artifacts/<session>/plan.{json,md}` — plan.json ✓; plan.md missing, see F5.
- [x] `pipeline_approvals` row has decision + timestamp. ✓
- [x] R7 snapshot — N/A Phase 1.

## Decision

**Proceed to Phase 2 (Generator).** Phase 1 goal ("prove the pipeline model works end-to-end with zero code-modification risk") is met:

- Planner spawns correctly and produces actionable plans in <2 min.
- Approval flow persists decisions to DB with correct schema.
- R3 guard prevents pipeline/human collision at the MCP layer (the key safety rail).
- Stage diagnostics scaffolding (TASK-557) is in place for when planner failures return.

F5 (plan.md emission) is a small UX/review polish, not a blocker. F6 is a spec mismatch, not a code change.

## Next actions

1. Close TASK-544 as DONE with this report attached.
2. Optional low-priority follow-up: emit `plan.md` alongside `plan.json` (F5).
3. Start Phase 2 — Generator stage design + implementation.
