# Phase 1 E2E Validation — 2026-04-20

**Task:** TASK-544 — E2E Phase 1 validation
**Session:** SESSION-1776692782985-1
**Attempts:** 1 (pipeline session SESSION-1776693022570-1, aborted)
**Verdict:** **Iterate Phase 1 — do NOT proceed to Phase 2 Generator yet**

## Setup

- Branch: `main` @ 062176d (Phase 3 UI merged in #21 / 925f3f6)
- Electron dev server running out of `C:\dev\choda-deck`
- Task picked for pipeline: **TASK-532** (Move vault-importer out of src/tasks/) — smallest scope, zero dependencies

## Run log

1. `session_start projectId=choda-deck` → SESSION-1776692782985-1, open conv CONV-1776692782986-2
2. `session_pick taskId=TASK-544` → session tracks TASK-544 as IN-PROGRESS
3. `pipeline_start taskId=TASK-532 evaluator=off` → **returned success** (stage=plan, status=running)
   - Expected: R3 guard block (interactive conv was open); did not trigger
4. Planner fired asynchronously in MCP process
5. Within ~30 s planner failed; session persisted as `stageStatus=rejected`, iteration=1
6. DB query `pipeline_approvals WHERE session_id=SESSION-1776693022570-1` returned a single row:
   - `decision=reject`
   - `feedback="[planner non-zero exit 1: ]"` — empty stderr, empty parsed.result
7. UI observations (Electron dev window, Phase 3 code):
   - Sidebar badge turned **amber (rejected)** on project `choda-deck` ✓
   - Pipeline tab appeared in tab bar (gating correct) ✓
   - Opening the tab surfaced an "error invoke session" banner — likely `pipeline:read-plan` ENOENT because `plan.json` was never written
8. `pipeline_abort sessionId=SESSION-1776693022570-1` → stage=aborted, status=null
   - Sidebar badge cleared, Pipeline tab disappeared — `onAnyStageChange` broadcast propagated correctly

## Findings

### F1 — R3 guard gap (blocking)

Interactive conversation `CONV-1776692782986-2` was open for the session, yet `pipeline_start` for a task in the same project did not raise `INTERACTIVE_CONV_BLOCKING`. The whole point of R3 is to prevent pipeline/human collision on one project; currently the guard silently passes.

Hypothesis: `conversations.findActiveByOwnerType(projectId, 'interactive')` only matches rows with `owner_type='interactive'`, but `session_start` does not assign that owner_type.

→ Tracked in **TASK-556** (priority high, READY).

### F2 — Planner silent failure (blocking debug)

`[planner non-zero exit 1: ]` is unactionable. `summariseFailure()` only exposes `stderr.slice(0,200)` or `parsed.result.slice(0,200)`. When both are empty, no root cause surfaces. Claude CLI did emit valid JSON to stdout (JSON.parse succeeded — otherwise `StageInvalidOutputError` would have fired), but the parsed shape was blank-result + non-zero exit.

Reproducing the exact command from a shell OUTSIDE the MCP process worked (Claude returned a full plan JSON, cost ~$0.10, under the $0.25 budget). So the failure is specific to the MCP/Electron-as-Node spawn context — most likely an env / PATH / stdin difference I cannot confirm without logging.

→ Tracked in **TASK-557** (priority high, READY).

### F3 — Phase 3 UI transitions validated ✓

Despite the planner failure, TASK-543 Phase 3 UI behaved exactly as designed:
- Active session detected, badge appeared
- `stageStatus=rejected` rendered the amber badge (spec)
- Pipeline tab gating honoured the per-project active-session map
- `pipeline_abort` propagated via `pipeline:any-stage-change` and removed both badge + tab

This is the first live confirmation of Phase 3 beyond typecheck / vitest. No renderer changes needed.

### F4 — "error invoke session" banner

When the Pipeline tab opens for a session whose stage is `plan` + status `rejected`, `pipeline:read-plan` IPC throws ENOENT (plan.json never written). The renderer surfaces this as a generic error string rather than a rejected-state placeholder.

→ Not blocking; will be revisited alongside TASK-557 once we can successfully drive a rejection path through the planner on purpose.

## Acceptance checklist (TASK-544)

- [x] Plan.md readable, actionable — **N/A** (planner never produced a plan)
- [ ] Notification arrive trong <2 min — not observed (no ready state reached)
- [ ] Approval → `stage='done'` — not observed
- [ ] R3 guard rejects pipeline when interactive conv is open — **failed, see F1 / TASK-556**
- [ ] Artifact layout `artifacts/<session>/plan.{json,md}` — no plan.json written
- [x] `pipeline_approvals` row has decision + timestamp — confirmed (reject row present)
- [ ] Phase 3 UI reflects stage transitions — **passed, see F3**

## Decision

**Iterate Phase 1.** Proceeding to Phase 2 Generator on top of a planner we cannot drive (F2) and a broken R3 guard (F1) would multiply the debug surface. Close F1 + F2 first, then re-run TASK-544 on TASK-532 and TASK-551 to cover paths A / B / C.

## Next actions

1. Resolve **TASK-556** (R3 guard) — critical correctness bug.
2. Resolve **TASK-557** (stage-runner observability) — unblocks all future planner debugging.
3. Re-open TASK-544 after the two follow-ups land; run on TASK-532 (happy path A) and TASK-551 (revision path B) to cover the remaining assertions.
