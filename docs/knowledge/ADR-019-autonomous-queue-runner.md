---
type: decision
title: "ADR-019: Autonomous Queue Runner — sequential `auto-safe` task executor"
projectId: choda-deck
scope: project
refs:
  - path: src/core/executor/coder.ts
    commitSha: cedaeb56f023acd0fecfd6ceeaae65a7f1becfd8
  - path: src/core/domain/auto-safe-validator.ts
    commitSha: cedaeb56f023acd0fecfd6ceeaae65a7f1becfd8
  - path: src/core/domain/lifecycle/session-lifecycle-service.ts
    commitSha: cedaeb56f023acd0fecfd6ceeaae65a7f1becfd8
  - path: src/core/paths.ts
    commitSha: cedaeb56f023acd0fecfd6ceeaae65a7f1becfd8
createdAt: 2026-05-10
lastVerifiedAt: 2026-05-29
status: superseded
---

# ADR-019: Autonomous Queue Runner — sequential `auto-safe` task executor

> **Status (2026-05-29): SUPERSEDED by TASK-982 — queue runner subsystem removed.**
> The `run-queue` + `queue start` CLI, `QueueLifecycleService`, `auto-safe` validator,
> `task_approve`/`task_reject` MCP tools, and the `REVIEW` task status were all deleted.
> Postgres queue composite (TASK-934 19/N) reverted. Backup branch: `origin/archive/queue-runner`
> at `45ef97c`. Reinstating the subsystem means resurrecting that branch, not iterating from
> this ADR. See INBOX-395 + CONV-1780022899678-9 for the removal rationale.

> **Status:** ✅ Accepted (v2)
> **Trigger:** INBOX-139 — Butter wants `1 lệnh chạy hết list task READY tự động qua đêm`. Conversation CONV-1778403102806-1 (multi-instance research, v1 had 5 design issues caught by review MSG-1778417920748-19; v2 lock-ins below).

---

## Context

[[auto-safe-label-spec]] (TASK-652, 2026-05-05) defined the **task contract** for autonomous execution. Quote: *"Whether/when to spawn an executor is a separate decision."* — that decision was deferred, this ADR makes it.

[[ADR-017-headless-spawn-strategy]] chốt **`claude -p`** là spawn primitive. [[ADR-009-session-lifecycle]] defines per-task session wrap. [[ADR-015-lifecycle-service-pattern]] mandates composite ops live in `*LifecycleService`, not CLI handlers.

`src/core/executor/coder.ts` (`ClaudePCoderDriver`) đã có spawn primitive cho FE Playwright pilot (TASK-679). Run-queue = **thin loop wrapper** quanh existing infrastructure, KHÔNG re-implement.

**ADR-014 SUPERSEDED warning**: Butter đã build self-written Planner→Generator→Evaluator pipeline (PR #25 commit 510ff0b) rồi xóa toàn bộ. Run-queue must remain **single-spawn-per-task**, no in-task pipeline stages.

## Decision

**Build `choda-deck run-queue --workspace <id>` CLI** wrapping a new `QueueLifecycleService`. Sequential, single-`claude -p`-spawn-per-task, gate on `auto-safe` label, **accumulate diffs across success tasks** (no auto-commit), halt on first failure.

### Surface

- **CLI**: `src/adapters/cli/commands/run-queue.ts` — thin entrypoint, parse args, delegate
- **Service**: `src/core/domain/lifecycle/queue-lifecycle-service.ts` — composite ops
- **Lifecycle extension**: `src/core/domain/lifecycle/session-lifecycle-service.ts` — add `abandonSession(id, reason)` method (does NOT touch task.status, leaves IN-PROGRESS)
- **Spawn**: reuse `ClaudePCoderDriver` from `src/core/executor/coder.ts`
- **MCP wrapper**: deferred to Phase 2

### Per-task lifecycle (v2 — split success/failure paths)

```
1. Pre-flight (queue start):
   - workspace_get(workspaceId) → resolve cwd, projectId
   - assert clean working tree (git status --porcelain empty)
   - task_list status=READY, projectId=workspace.projectId, label=auto-safe → ordered queue
     (NOTE: filter by projectId, NOT workspaceId — Task model has no workspaceId field)
   - per-task: warn if any File Pointer path doesn't exist under workspace.cwd
   - if empty queue → exit 0 with empty report

2. For each task (sequential):
   a. validateAutoSafeTask(task) → re-verify (Butter may have edited body since queue started)
      → fail = skip task, log to report, NEXT
   b. session_start(projectId, workspaceId, taskId)
   c. session_checkpoint('spawn-start')
   d. spawn claude -p (canonical signature below) — pass role prompt + task body via stdin
   e. parse JSON output: total_cost_usd, num_turns, is_error, result
   f. session_checkpoint('spawn-done', { cost, turns })
   g. parseAcCommands(task.body) → exec each in workspace.cwd
   h. branch:
      SUCCESS (claude is_error=false + all AC exit 0):
        - session_end → task_update DONE
        - tree may be dirty (Claude wrote files) — DO NOT clean. Diff accumulates across queue.
        - check post-hoc cost: if total_cost_usd > maxCostPerTask → mark cost-cap-exceeded, halt queue
        - else continue to next task
      FAILURE (claude is_error=true OR any AC exits non-zero):
        - task_update labels += 'auto-failed' (status STAYS IN-PROGRESS)
        - conversation_add(linkedConvId, reason + diff path) on session-linked conversation
        - abandonSession(sessionId, reason)  ← new method, does NOT update task.status
        - HALT queue (preserve dirty tree for Butter review)
   i. Per-queue gate: between tasks check cumulativeCost + nextTaskEstimate > queueCap → halt admission

3. Post-queue: write summary report to artifactRoot
   - List all DONE tasks + their per-task diff paths
   - Butter manually reviews accumulated diff (`git diff` from queue-start commit) + commits per-task or `git restore .` to discard everything
```

### Working tree contract (v2 — accumulate, halt on fail)

| Hook | Action |
|---|---|
| **Pre-queue (clean-in)** | Refuse run if `git status --porcelain` non-empty. Butter must commit/stash first. |
| **Per-task success** | Tree accumulates Claude's diff. Continue to next task. **No clean-between check.** |
| **Per-task fail** | Halt queue. Tree may contain partial work — preserved intentionally for review. |
| **End-of-queue** | Runner emits final summary listing all DONE tasks + per-task `diff.patch` paths. Butter reviews `git diff <queue-start-commit>` to see total accumulated changes, then manually commits subset OR `git restore . && git clean -fd` to discard all. |

**No `--auto-revert-on-fail` in MVP** — would discard accumulated success diffs (destructive). Defer to v1.5 with per-task git checkpoint mechanism if needed.

**No auto-commit, no auto-merge.** Butter responsible for final review + commit decisions.

### Canonical spawn signature

Spawn pattern locked by spike data (CONV-1778403102806-1, ~$0.25 spent across 6 spawns):

```typescript
spawn(claudeBin, [
  '-p',
  '--model', 'claude-sonnet-4-6',
  '--output-format', 'json',
  '--no-session-persistence',
  '--setting-sources', 'user',
  '--strict-mcp-config',
  '--mcp-config', queueMcpEmptyPath,            // {"mcpServers":{}}
  '--tools', 'Read,Edit,Write,Bash,Grep,Glob',
  '--allowed-tools', 'Bash(pnpm *) Bash(node *) Bash(git diff*) Bash(git status*)',
  '--permission-mode', 'bypassPermissions',
  '--max-budget-usd', '0.25',
], { cwd: workspace.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
// stdin: rolePrompt + '\n\n' + task.body (incl. ## Acceptance + ## File Pointers)
```

`queueMcpEmptyPath` = `src/adapters/cli/templates/queue-mcp-empty.json` (committed):
```json
{"mcpServers":{}}
```

**Why this exact set** (spike evidence):

| Flag | Saving / purpose |
|---|---|
| `--strict-mcp-config` + empty MCP | Drops 90 MCP tools — saves ~22k tokens / spawn |
| `--tools "Read,Edit,Write,Bash,Grep,Glob"` | Drops 24 unused built-in — saves ~8k tokens |
| `--permission-mode bypassPermissions` | Parity với existing `coder.ts:64`. Safe behind clean-tree + cost cap + auto-safe gate |
| `--max-budget-usd 0.25` | Claude self-aborts at ~$0.50 actual ceiling (only mid-spawn enforcement) |
| `--no-session-persistence` | No `~/.claude/projects/.../*.jsonl` pollution |
| `--setting-sources user` | Block workspace `.claude/settings.local.json` leak via cwd |
| `--output-format json` | Parse `total_cost_usd`, `is_error`, `result` after exit (single JSON, no streaming) |

Pure-coder cold spawn ≈ **14k tokens / $0.053** Sonnet 4.6. 60% saving vs full default.

### Cost contract (v2 — honest, post-hoc only)

| Layer | Mechanism | When enforced |
|---|---|---|
| **Per-spawn** | `--max-budget-usd 0.25` | Claude self-aborts mid-turn after cost > 0.25, actual ceiling ~$0.50 (soft cap, may overshoot ~2x per ADR-017) |
| **Per-task post-hoc** | parse `total_cost_usd` from spawn JSON output | Runner checks AFTER spawn exits — if exceeded, mark `auto-failed` reason `cost-cap-exceeded`, halt queue |
| **Per-queue gate** | cumulative tracking between tasks | Runner halts NEXT-task admission if `cumulativeCost + perTaskCap > queueCap` |
| **Override** | `--max-cost-per-task <n>` flag | Raises both per-spawn `--max-budget-usd` (50%) and post-hoc cap proportionally |

**Critical: Runner cannot kill subprocess mid-spawn for cost.** `--output-format json` returns single JSON only after exit. Only Claude's `--max-budget-usd` enforces during spawn. Runner enforces between spawns.

Cost matrix validated by spike (Sonnet 4.6 pure-coder cold + AC work):

| Task | Total | Within $0.50? |
|---|---|---|
| Trivial (1 file) | $0.08 | ✓ |
| Medium (5 files, 30k input + 5k output) | $0.22 | ✓ |
| Complex (10 files, 80k input + 15k output) | $0.52 | ⚠ post-hoc may exceed by 4% |
| Multi-turn refactor (5 turns × 30k+5k) | $0.88 | ❌ requires `--max-cost-per-task 1.50` override |

→ `auto-safe` validator scope ≤3h filters most multi-turn cases at task creation. If runner sees post-hoc cost > cap, mark `auto-failed`, log full diff for Butter triage.

### Failure encoding (v2 — abandonSession + label)

**No schema change** to `TaskStatus`. Failure path uses NEW lifecycle method:

```typescript
// New in src/core/domain/lifecycle/session-lifecycle-service.ts
abandonSession(id: string, reason: string): AbandonSessionResult {
  // Sets session.status = 'completed' with handoff.failureReason
  // Does NOT touch task.status (stays IN-PROGRESS)
  // Closes linked conversations
  // Returns abandoned session
}
```

Failure flow (per-task):
```typescript
task_update(taskId, { labels: [...labels, 'auto-failed'] })  // status stays IN-PROGRESS
conversation_add(linkedConvId, reason + diff path)
abandonSession(sessionId, reason)
// halt queue
```

Butter triages manually: reopen-and-fix via interactive Claude, or close as `CANCELLED`, or revert to `READY` after rollback.

### Gate predicate (v2 — project-level, not workspace)

```typescript
isAutoSafeReady(task: Task, workspace: Workspace): boolean {
  return task.status === 'READY'
    && task.projectId === workspace.projectId       // filter by project, not workspace
    && task.labels.includes('auto-safe')
    && validateAutoSafeTask(task).valid
}
```

`Task` model has no `workspaceId` field (`task-types.ts:158` confirms only `Session.workspaceId` exists). User picks workspace via `--workspace <id>` flag. Runner shows warning per task if File Pointer paths don't resolve under `workspace.cwd` — user responsibility to ensure task belongs to chosen workspace context.

Drop the `fe-playwright-test` requirement of existing `choda-deck run` (FE-specific). Run-queue is domain-agnostic.

### Retry policy

- **Logic fail** (AC commands exit non-zero, `claude -p` returns `is_error=true`) → no retry, halt queue
- **Transient fail** (rate-limit, network timeout, OOM, spawn crash before first turn) → retry 1x, same prompt. If retry also fails → mark auto-failed, halt
- Detection: parse stderr + exit code patterns; specific transient classes only (do not heuristic-classify "flaky test")

### AC validation strategy

- Extract `pnpm <subcommand>` lines, `node <script>` lines, fenced bash blocks from `## Acceptance` section of task body
- Exec each in `workspace.cwd` after Claude exits
- All exit 0 = AC pass. Any non-zero = AC fail
- `pnpm run lint` runs in **warning-only** mode if not in AC (logged to report, does not fail run)
- No blanket test runs (auto-safe spec already requires test command in AC if relevant)

### Interrupt UX

- SIGINT (Ctrl+C) lần 1: graceful — finish current task's claude spawn, run AC, write report, exit. Show ETA of current task in stdout.
- SIGINT lần 2: immediate — `kill -INT` claude subprocess (Claude Code respects SIGINT), ship partial diff to artifact dir, write report with `interrupted=true`, exit 130.
- No SIGKILL until lần 3 (10s after lần 2).

### Artifact layout

```
<resolveDataPaths().artifactsDir>/
└── queue-<sessionId>/
    ├── summary.md              ← human report (lists all DONE + auto-failed tasks + diff paths)
    ├── summary.json            ← machine report
    ├── tasks/
    │   ├── TASK-NNN/
    │   │   ├── prompt.md       ← stdin sent to claude
    │   │   ├── claude.json     ← --output-format json result
    │   │   ├── ac-<n>.log      ← per-AC-command stdout/stderr
    │   │   ├── diff.patch      ← per-task git diff (always written, even if auto-failed)
    │   │   └── lint.log        ← warning-only lint output
    │   └── ...
    └── queue.jsonl             ← per-task summary stream (for live tail)
```

### CLI flags (v2)

```
choda-deck run-queue --workspace <id> [options]

Required:
  --workspace <id>            Workspace label (resolves cwd + projectId)

Options:
  --max-cost-per-task <n>     Override per-task cap (default 0.50 USD).
                              Also raises --max-budget-usd to n/2 for the spawn.
  --max-tasks <n>             Stop after N tasks (default unlimited)
  --dry-run                   Validate gates + list tasks, no spawn
  --json                      Emit JSON summary
  --claude-bin <path>         Override claude executable
  --pnpm-bin <path>           Override pnpm executable
  --model <id>                Override model (default claude-sonnet-4-6)

Exit codes:
  0   all tasks DONE
  1   one or more tasks auto-failed (queue halted on first fail)
  2   bad args
  3   workspace not found
  4   pre-flight clean-tree check failed
  5   queue cost cap exceeded
  130 interrupted (SIGINT)
```

## Consequences

### Positive

- **Reuse map**: spawn primitive from `ClaudePCoderDriver`. Lifecycle service composes existing `session_*` ops + ONE new method (`abandonSession`). Validator existed already.
- **60% baseline cost saving** vs naive spawn — pure-coder mode = $0.053/cold-spawn Sonnet.
- **No schema change** for failure encoding — labels + new lifecycle method cover it.
- **Honest mechanism wording** — runner does not over-promise mid-spawn enforcement.
- **Project-level filter matches existing model** — no Task.workspaceId schema change.
- **Compatible with existing `choda-deck run` pilot** — both share `ClaudePCoderDriver`. Pilot keeps `+ fe-playwright-test`, queue drops it.

### Negative

- **`bypassPermissions` is wide**: Claude can run pnpm/node/git diff per allowlist. Mitigation: scoped Bash patterns block `git push`/`curl`/`rm`. Ultimate guard = clean-tree review at queue end.
- **Multi-turn refactor tasks vượt $0.50 cap** — runner marks auto-failed post-hoc. Acceptable: auto-safe spec targets ≤3h scope.
- **Halt-on-first-fail wastes queue** — 1 fail at task 2 of 20 wastes 18 unrun tasks. Acceptable for MVP (Butter triages in morning).
- **Cache cold cost ~$0.05/spawn** baseline. Acceptable for personalization tool.
- **User responsible for workspace-task alignment** — runner only warns on path mismatch, doesn't enforce. Mitigation: warning + dry-run mode for sanity check before queue.

### Out of scope (deferred)

- **Worktree-per-task isolation** — defer to v1.5 if state contamination shows up
- **Auto-commit per turn** — drops with worktree-per-task deferral
- **`--auto-revert-on-fail`** — destructive in shared-tree-accumulate model. Defer to v1.5 with git checkpoint mechanism
- **MCP wrapper `task_queue_run`** — Phase 2
- **Parallel execution** — Phase 2
- **`BLOCKED` task status** — only if Kanban needs it independently
- **Memory read-only sandbox** — premature; revisit if pollution observed
- **Mid-spawn cost telemetry via stream-json** — defer until cap-overshoot becomes recurring problem

## Risks

### 🟡 Accept for MVP

**R1. `bypassPermissions` blast radius** — Claude can damage workspace files. Safety envelope: clean-tree + cost cap + auto-safe scope ≤3h. Tighten via Phase 1.5 if unsafe runs observed.

**R2. Multi-turn refactor budget overflow** — `auto-safe` validator enforces ≤3h scope but doesn't enforce turn count. Mitigation: post-hoc cost check + halt. Risk = wasted spend up to ~$1 per task ($0.50 cap × 2x soft cap overshoot).

**R3. AC command parsing fragility** — extracting `pnpm <cmd>` from markdown is regex-based. Mitigation: only match lines starting with `pnpm`/`node` or fenced bash blocks. Auto-safe validator enforces shape.

**R4. Halt-on-first-fail wastes queue** — 1 fail at task 2 of 20 wastes 18 unrun tasks. Mitigation: Butter reviews on-call style (queue should converge once tasks well-formed). Future v1.5 may add `--continue-on-fail` flag with explicit accept-fail policy.

**R5. Spawn cache key drift** — different `--mcp-config` paths or workspace cwds create different cache keys. Mitigation: stable artifact path + same `queueMcpEmptyPath`.

**R6. User-responsibility for workspace-task fit** — no enforcement that task.body file pointers exist under workspace.cwd. Runner emits warning only. If user runs queue with wrong workspace, Claude gets task pointing at non-existent paths → fails AC → halts. Acceptable: dry-run mode previews this.

**R7. Accumulated diff complexity at queue end** — after 10 success tasks, Butter sees tree with all changes mixed. Mitigation: per-task `diff.patch` artifact lets Butter review per-task before bulk commit. May want git-add-by-task helper later.

### 🟢 Low

**R8. `--tools` flag MCP filter gap** — confirmed by spike. Combined with `--strict-mcp-config` + empty config, MCP fully dropped.

**R9. Stream-json large output** — runner uses `--output-format json` (single result). No scaling concern.

**R10. Subprocess SIGINT propagation on Windows** — Claude Code respects SIGINT per ADR-017. Node `child.kill('SIGINT')` works on Windows.

## Implementation phases

**Phase 1 — MVP (this ADR's scope, ~5h total)**:
- TASK-698: `QueueLifecycleService` + AC parser + `abandonSession` extension to SessionLifecycleService (~3.5h)
- TASK-699: `choda-deck run-queue` CLI thin entrypoint (~2h)

**Phase 2 — Hardening (defer until usage data)**:
- MCP wrapper `task_queue_run` for UI trigger
- Per-task git checkpoint + `--auto-revert-on-fail` if dirty cascade hits
- Worktree-per-task if state contamination observed
- Token usage telemetry vs spike $0.05 baseline
- Stream-json mid-spawn cost telemetry if cap-overshoot recurring

**Phase 3 — Scaling (if needed)**:
- Parallel via worktree
- `--continue-on-fail` policy
- Cross-queue resume
- `BLOCKED` status promotion

## Reference

- Spike evidence: CONV-1778403102806-1 (multi-instance research, ~$0.25 across 6 spawns measuring MCP-filter token economics)
- Spike artifacts: `C:\tmp\sonnet-default.jsonl`, `sonnet-strict-empty.jsonl`, `sonnet-strict-empty-tools.jsonl` + Haiku equivalents
- CLI version validated: claude 2.1.138 (May 2026)
- **Models**: `claude-sonnet-4-6` chosen as default per Butter explicit direction at spike #3 (CONV msg `MSG-1778417290488-8`). Initial spike #2 convergence had recommended Haiku 4.5 for ~50% baseline cost saving; Butter prioritized Sonnet capability over cost for code-edit work. Haiku alternative via `--model claude-haiku-4-5-20251001` override (recalc per-task cap proportionally — Haiku cold ~$0.04, fits $0.30 cap).
- **v1 → v2 design issues** caught by review MSG-1778417920748-19: 5 issues (working-tree contradiction, session_end coupling, cost-cap over-promise, workspace filter, default model rationale). All locked-in fixes above.

## Related

- [[ADR-017-headless-spawn-strategy]] — spawn primitive (this ADR is its second consumer beyond `coder.ts`)
- [[ADR-009-session-lifecycle]] — `session_start`/`session_checkpoint`/`session_end` reused; this ADR adds `abandonSession`
- [[ADR-015-lifecycle-service-pattern]] — `QueueLifecycleService` follows pattern
- [[auto-safe-label-spec]] — task contract; runner enforces gate
- [[ADR-014-harness-engine-architecture]] — SUPERSEDED. Run-queue must NOT regrow into staged pipeline.
- [[playwright-executor-pilot-runbook]] — sibling runner; shares `ClaudePCoderDriver`

## Change log

- **2026-05-10 (v1)** — initial draft. Locked-in by CONV-1778403102806-1 with 9 decisions. Spike evidence: 6 spawns, $0.25 total.
- **2026-05-10 (v2 — review fixes)** — 5 issues caught by review MSG-1778417920748-19. Locked fixes:
  - F1: working-tree contract rewritten — accumulate diffs across success tasks, halt only on fail (clean-IN at queue start only, no clean-between)
  - F2: new `abandonSession(sessionId, reason)` method on SessionLifecycleService for failure path — does NOT update task.status (existing `endSession` always sets DONE)
  - F3: cost contract reworded — runner does post-hoc accounting only, Claude `--max-budget-usd` is sole mid-spawn enforcement
  - F4: gate predicate filters by `projectId` (workspace.projectId), not workspaceId — Task model has no workspaceId field
  - F5: explicit Sonnet rationale added to Reference section — Butter chose Sonnet over Haiku-cost-savings for code capability
  - Drop `--auto-revert-on-fail` from MVP CLI flags — destructive in accumulate model, defer to v1.5
  - TASK-698 scope expanded ~30 min for `abandonSession` method + tests (still ~3.5h, fits ≤3h auto-safe target with bare margin — acceptable)
