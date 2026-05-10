---
type: decision
title: "ADR-019: Autonomous Queue Runner — sequential `auto-safe` task executor"
projectId: choda-deck
scope: project
refs:
  - path: src/core/executor/coder.ts
    commitSha: 9b170b39b3d44ecef8fa4a64f2c9c72401f287d3
  - path: src/core/domain/auto-safe-validator.ts
    commitSha: 9b170b39b3d44ecef8fa4a64f2c9c72401f287d3
  - path: src/core/domain/lifecycle/session-lifecycle-service.ts
    commitSha: 9b170b39b3d44ecef8fa4a64f2c9c72401f287d3
  - path: src/core/paths.ts
    commitSha: 9b170b39b3d44ecef8fa4a64f2c9c72401f287d3
createdAt: 2026-05-10
lastVerifiedAt: 2026-05-10
---

# ADR-019: Autonomous Queue Runner — sequential `auto-safe` task executor

> **Status:** ✅ Accepted
> **Trigger:** INBOX-139 — Butter wants `1 lệnh chạy hết list task READY tự động qua đêm`. Conversation CONV-1778403102806-1 (multi-instance research, 9 decisions locked).

---

## Context

[[auto-safe-label-spec]] (TASK-652, 2026-05-05) defined the **task contract** for autonomous execution. Quote: *"Whether/when to spawn an executor is a separate decision."* — that decision was deferred, this ADR makes it.

[[ADR-017-headless-spawn-strategy]] chốt **`claude -p`** là spawn primitive. [[ADR-009-session-lifecycle]] defines per-task session wrap. [[ADR-015-lifecycle-service-pattern]] mandates composite ops live in `*LifecycleService`, not CLI handlers.

`src/core/executor/coder.ts` (`ClaudePCoderDriver`) đã có spawn primitive cho FE Playwright pilot (TASK-679). Run-queue = **thin loop wrapper** quanh existing infrastructure, KHÔNG re-implement.

**ADR-014 SUPERSEDED warning**: Butter đã build self-written Planner→Generator→Evaluator pipeline (PR #25 commit 510ff0b) rồi xóa toàn bộ. Run-queue must remain **single-spawn-per-task**, no in-task pipeline stages.

## Decision

**Build `choda-deck run-queue --workspace <id>` CLI** wrapping a new `QueueLifecycleService`. Sequential, single-`claude -p`-spawn-per-task, gate on `auto-safe` label, fail-fast on dirty working tree.

### Surface

- **CLI**: `src/adapters/cli/commands/run-queue.ts` — thin entrypoint, parse args, delegate
- **Service**: `src/core/domain/lifecycle/queue-lifecycle-service.ts` — composite ops
- **Spawn**: reuse `ClaudePCoderDriver` from `src/core/executor/coder.ts` (or factor out if signatures diverge)
- **MCP wrapper**: deferred to Phase 2 (`task_queue_run` if Butter wants UI trigger later)

### Per-task lifecycle

```
1. Pre-flight (queue start):
   - workspace_get(workspaceId) → resolve cwd
   - assert clean working tree (git status --porcelain empty)
   - task_list status=READY, label=auto-safe, workspace=X → ordered queue
   - if empty queue → exit 0 with empty report

2. For each task (sequential):
   a. validateAutoSafeTask(task) → re-verify (Butter may have edited body)
      → fail = skip task, log to report, NEXT
   b. session_start(projectId, workspaceId, taskId)
   c. session_checkpoint('spawn-start')
   d. spawn claude -p (canonical signature below) — pass role prompt + task body via stdin
   e. parse JSON output: total_cost_usd, num_turns, is_error, result
   f. session_checkpoint('spawn-done', { cost, turns })
   g. parseAcCommands(task.body) → exec each in workspace.cwd
   h. validate clean-between: git status --porcelain
   i. branch:
      - all AC commands exit 0 + tree clean → task_update DONE + session_end
      - any AC fail OR tree dirty → task_update labels += 'auto-failed' (status stays IN-PROGRESS)
        + add reason to conversation linked to session
        + session_end with handoff
        + halt queue (stop-on-dirty contract)
   j. if cost cap exceeded → kill subprocess, mark auto-failed with reason cost-cap-exceeded

3. Post-queue: write summary report to artifactRoot
```

### Canonical spawn signature

Spawn pattern locked by spike data (CONV-1778403102806-1 messages 5–8, ~$0.25 spent):

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
| `--strict-mcp-config` + empty MCP | Drops 90 MCP tools (Gmail/Drive/Postgres/Playwright/etc) — saves ~22k tokens / spawn |
| `--tools "Read,Edit,Write,Bash,Grep,Glob"` | Drops 24 unused built-in (Task, ToolSearch, WebFetch, EnterPlanMode, etc) — saves ~8k tokens |
| `--permission-mode bypassPermissions` | Parity với existing `coder.ts:64`. Safe behind clean-tree + cost cap + auto-safe gate |
| `--max-budget-usd 0.25` | Soft cap ~2x = $0.50 actual ceiling = per-task cap |
| `--no-session-persistence` | No `~/.claude/projects/.../*.jsonl` pollution |
| `--setting-sources user` | Block workspace `.claude/settings.local.json` leak via cwd |
| `--output-format json` | Parse `total_cost_usd`, `is_error`, `result` directly |

Pure-coder cold spawn ≈ **14k tokens / $0.053** Sonnet 4.6. 60% saving vs full default.

### Cost contract

| Layer | Cap | Mechanism |
|---|---|---|
| Per-spawn | `--max-budget-usd 0.25` | Claude soft cap, ~2x = $0.50 actual ceiling |
| Per-task | $0.50 hard | Runner kills subprocess if cumulative spawn cost > $0.50 |
| Per-queue | dynamic = `tasks.length × $0.50` | Runner halts queue when cumulative > cap |
| Override | `--max-cost-per-task <n>` flag | For complex tasks Butter knows need more budget |

Cost matrix validated by spike (Sonnet 4.6 pure-coder cold + AC work):

| Task | Total | Within $0.50? |
|---|---|---|
| Trivial (1 file) | $0.08 | ✓ |
| Medium (5 files, 30k input + 5k output) | $0.22 | ✓ |
| Complex (10 files, 80k input + 15k output) | $0.52 | ⚠ tight, +4% over |
| Multi-turn refactor (5 turns × 30k+5k) | $0.88 | ❌ requires override |

→ `auto-safe` validator scope ≤3h filters out most multi-turn-refactor cases at task creation. If runner hits cap mid-task, mark `auto-failed` with reason `cost-cap-exceeded`, log partial diff for Butter triage.

### Failure encoding

**No schema change** to `TaskStatus` (stays `TODO|READY|IN-PROGRESS|DONE|CANCELLED`). Failure = label-based:

- Task fails AC → `task_update` adds label `auto-failed`, status stays `IN-PROGRESS`
- Failure reason written to conversation linked to session via `conversation_add` + `session_checkpoint`
- Butter manually triages: reopen-and-fix via interactive Claude, or close as `CANCELLED`, or revert to `READY` after rollback

### Working tree safety contract

| Hook | Action |
|---|---|
| **Pre-queue (clean-in)** | Refuse run if `git status --porcelain` non-empty. Butter must commit/stash first. |
| **Pre-task (clean-between)** | Same check before each task admission. Halts queue if prior task left dirty state. |
| **Post-task (stop-on-dirty)** | After AC exec, re-check `git status --porcelain`. If dirty even though AC passed, halt queue (assume stale uncommitted artifact). |
| **`--auto-revert-on-fail` (opt-in, default OFF)** | After task fail, run `git restore . && git clean -fd` then continue queue. **Destructive** — losses any uncommitted file Claude wrote. Document explicitly. If revert itself errors, halt immediately. |

No auto-commit. No auto-merge. Butter reviews diffs manually post-queue.

### Retry policy

- **Logic fail** (AC commands exit non-zero, `claude -p` returns `is_error=true`) → no retry, mark `auto-failed` immediately
- **Transient fail** (rate-limit, network timeout, OOM, spawn crash before first turn) → retry 1x, same prompt. If retry also fails → `auto-failed`
- Detection: parse stderr + exit code patterns; specific transient classes only (do not heuristic-classify "flaky test")

### AC validation strategy

- Extract `pnpm <subcommand>` lines, `node <script>` lines, fenced bash blocks from `## Acceptance` section of task body
- Exec each in `workspace.cwd` after Claude exits
- All exit 0 = AC pass. Any non-zero = AC fail
- `pnpm run lint` runs in **warning-only** mode if not in AC (logged to report, does not fail run)
- No blanket test runs (auto-safe spec already requires test command in AC if relevant)

### Gate predicate

```typescript
isAutoSafeReady(task: Task): boolean {
  return task.status === 'READY'
    && task.labels.includes('auto-safe')
    && validateAutoSafeTask(task).valid
}
```

Drop the `fe-playwright-test` requirement of existing `choda-deck run` (that gate is FE-specific). Run-queue is domain-agnostic.

### Interrupt UX

- SIGINT (Ctrl+C) lần 1: graceful — finish current task's claude spawn, run AC, write report, exit. Show ETA of current task in stdout.
- SIGINT lần 2: immediate — `kill -INT` claude subprocess (Claude Code respects SIGINT), ship partial diff to artifact dir, write report with `interrupted=true`, exit non-zero.
- No SIGKILL until lần 3 (10s after lần 2).

### Artifact layout

```
<resolveDataPaths().artifactsDir>/
└── queue-<sessionId>/
    ├── summary.md              ← human report
    ├── summary.json            ← machine report
    ├── tasks/
    │   ├── TASK-NNN/
    │   │   ├── prompt.md       ← stdin sent to claude
    │   │   ├── claude.json     ← --output-format json result
    │   │   ├── ac-<n>.log      ← per-AC-command stdout/stderr
    │   │   ├── diff.patch      ← git diff after spawn (always written, even if auto-failed)
    │   │   └── lint.log        ← warning-only lint output
    │   └── ...
    └── queue.jsonl             ← per-task summary stream (for live tail)
```

### CLI flags

```
choda-deck run-queue --workspace <id> [options]

Required:
  --workspace <id>            Workspace label

Options:
  --max-cost-per-task <n>     Override per-task cap (default 0.50 USD)
  --max-tasks <n>             Stop after N tasks (default unlimited)
  --auto-revert-on-fail       Run `git restore . && git clean -fd` after fail (default OFF)
  --dry-run                   Validate gates + list tasks, no spawn
  --json                      Emit JSON summary
  --claude-bin <path>         Override claude executable
  --pnpm-bin <path>           Override pnpm executable

Exit codes:
  0   all tasks DONE
  1   one or more tasks auto-failed (queue may have halted)
  2   bad args
  3   workspace not found
  4   pre-flight clean-tree check failed
  5   queue cost cap exceeded
  130 interrupted (SIGINT)
```

## Consequences

### Positive

- **Reuse map**: 0 new spawn code (reuse `ClaudePCoderDriver` or factor shared module). Lifecycle service composes existing `session_*` ops. Validator existed already (TASK-652).
- **60% baseline cost saving** vs naive spawn (spike evidence). Pure-coder mode = $0.053/cold-spawn Sonnet.
- **No schema change** for failure encoding — labels + conversations cover it. Defer `BLOCKED` status until Butter decides Kanban needs it independently.
- **Safety envelope**: clean-tree contract + per-task cost cap + bounded retry + auto-safe gate + bypassPermissions only behind that envelope.
- **Compatible with existing `choda-deck run` pilot** — both share `ClaudePCoderDriver`, both gate on `auto-safe`. Pilot keeps `+ fe-playwright-test`, queue drops it.

### Negative

- **`bypassPermissions` is wide**: Claude can run arbitrary `pnpm`/`node`/`git diff` per allowlist, plus any tool in `--tools` set without prompts. Mitigation: scoped Bash patterns block `git push`/`curl`/`rm`. Ultimate guard = clean-tree + git diff review.
- **Multi-turn refactor tasks vượt $0.50 cap** — runner marks auto-failed mid-task. Butter must break down or override. Acceptable: auto-safe spec already targets ≤3h scope.
- **Halt-on-dirty cascade**: 1 failure mid-queue halts rest. `--auto-revert-on-fail` opt-in mitigates but is destructive. Acceptable for MVP unattended overnight runs (Butter triages in morning).
- **Cache cold cost ~$0.05/spawn** baseline overhead even for trivial tasks. Acceptable for personalization tool.

### Out of scope (deferred)

- **Worktree-per-task isolation** — original Copilot proposal upgrade. Defer to v1.5 if state contamination shows up in usage.
- **Auto-commit per turn** — drops with worktree-per-task deferral.
- **MCP wrapper `task_queue_run`** — Phase 2 if Butter wants UI trigger.
- **Parallel execution** — Phase 2.
- **`BLOCKED` task status** — only if Kanban needs it independently of runner.
- **Memory read-only sandbox** — premature; revisit if pollution observed in first 5-10 runs.

## Risks

### 🟡 Accept for MVP

**R1. `bypassPermissions` blast radius** — Claude can damage workspace files Claude is allowed to touch (pnpm/node/git scoped). Safety envelope in design (clean-tree + cost cap + auto-safe scope ≤3h). If Butter sees unsafe runs, tighten `--tools` allowlist via Phase 1.5.

**R2. Multi-turn refactor budget overflow** — `auto-safe` validator enforces ≤3h scope but doesn't enforce turn count. Mitigation: cost cap kills runaway. Risk = wasted spend up to $0.50/task.

**R3. AC command parsing fragility** — extracting `pnpm <cmd>` lines from markdown body is regex-based. Edge case: AC mentions command in prose not as a check. Mitigation: only match lines starting with `pnpm`/`node` or fenced bash blocks. Auto-safe validator already enforces shape.

**R4. Halt-on-dirty wastes queue** — 1 fail at task 2 of 20 wastes 18 unrun tasks. Mitigation: Butter uses `--auto-revert-on-fail` for trusted workspaces; for new code reviews uses default halt-on-dirty.

**R5. Spawn cache key drift** — different `--mcp-config` paths or workspace cwds create different cache keys → cold spawn each time. Mitigation: stable artifact path + same `queueMcpEmptyPath` keep cache warm within queue.

### 🟢 Low

**R6. `--tools` flag MCP filter gap** — confirmed by spike that `--tools` only filters built-in tools, not MCP. Combined with `--strict-mcp-config` + empty config, MCP fully dropped.

**R7. Stream-json large output** — runner uses `--output-format json` (single result), not stream-json. No scaling concern for queue.

**R8. Subprocess SIGINT propagation on Windows** — Claude Code respects SIGINT per ADR-017. Node `child.kill('SIGINT')` works on Windows (sends CTRL_C_EVENT).

## Implementation phases

**Phase 1 — MVP (this ADR's scope, ~5h total)**:
- TASK-A: `QueueLifecycleService` with composite per-task lifecycle (~3h)
- TASK-B: `choda-deck run-queue` CLI thin entrypoint (~2h)

**Phase 2 — Hardening (defer until usage data)**:
- MCP wrapper `task_queue_run` for UI trigger
- `--auto-revert-on-fail` if dirty cascade hits
- Worktree-per-task if state contamination observed
- Token usage telemetry (compare actual cold cost vs spike $0.05 baseline)

**Phase 3 — Scaling (if needed)**:
- Parallel via worktree
- Cross-queue resume (pickup where last queue stopped)
- `BLOCKED` status promotion

## Reference

- Spike evidence: CONV-1778403102806-1 messages 5–8 (3 cost ceilings analysis + token breakdown)
- Spike artifacts: `C:\tmp\sonnet-default.jsonl`, `sonnet-strict-empty.jsonl`, `sonnet-strict-empty-tools.jsonl` + Haiku equivalents (~$0.25 total spend)
- CLI version validated: claude 2.1.138 (May 2026)
- Models: `claude-sonnet-4-6` default, override via `--model` if needed (cost cap recalc)

## Related

- [[ADR-017-headless-spawn-strategy]] — spawn primitive choice (this ADR is its first consumer beyond `coder.ts`)
- [[ADR-009-session-lifecycle]] — `session_start`/`session_checkpoint`/`session_end` reused
- [[ADR-015-lifecycle-service-pattern]] — `QueueLifecycleService` follows this pattern
- [[auto-safe-label-spec]] — task contract; runner enforces gate
- [[ADR-014-harness-engine-architecture]] — SUPERSEDED. Run-queue must NOT regrow into staged pipeline.
- [[playwright-executor-pilot-runbook]] — sibling runner; shares `ClaudePCoderDriver`

## Change log

- **2026-05-10 (v1)** — initial draft. Locked-in by CONV-1778403102806-1 with 9 decisions (4 Butter explicit, 2 both Claude instances aligned, 3 default + Copilot review). Spike evidence: 6 spawns measured, $0.25 total. Architecture identical to inbox shape; only spawn-config + cost-matrix detail added during research.
