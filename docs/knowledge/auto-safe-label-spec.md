---
type: decision
title: auto-safe label — task contract for autonomous execution
projectId: choda-deck
scope: project
refs:
  - path: src/core/domain/auto-safe-validator.ts
    commitSha: cedaeb56f023acd0fecfd6ceeaae65a7f1becfd8
  - path: src/adapters/mcp/mcp-tools/task-tools.ts
    commitSha: cedaeb56f023acd0fecfd6ceeaae65a7f1becfd8
createdAt: 2026-05-05
lastVerifiedAt: 2026-05-11
auditRef: docs/knowledge/auto-safe-validator-audit-2026-05-11.md
---

# auto-safe label — task contract for autonomous execution

> AI-Context: a task may carry the `auto-safe` label only when its body proves the task is small, scoped, and verifiable enough that any executor (Butter, `/team`, future runner) can finish it without further clarification. The validator at `src/core/domain/auto-safe-validator.ts` is the single source of truth for the contract; the MCP `task_update` and `tasks_update_batch` handlers reject the label if the body fails the contract.

## Status

Accepted — 2026-05-05. Implemented in TASK-652. Independent of any orchestrator: the contract tightens task spec quality whether the executor is human or autonomous.

## Why this exists

ADR-014 (self-written orchestrator) was superseded 2026-04-23 in favor of Claude Code `/team`. The orchestrator went away; the *delegability* problem stayed. Two failure modes recur regardless of executor:

1. **Vague AC** — "make it work", "investigate" — no objective stop signal. Executor invents one, gets it wrong.
2. **Hidden scope** — task estimated 1h, body actually implies 8h of refactor. Wasted spawns / aborted PRs.

The `auto-safe` label is opt-in. Adding it asserts: *this task body is concrete enough to execute without back-and-forth.* The validator enforces the assertion before the label sticks.

## Contract

When label `auto-safe` is added (`task_update` or `tasks_update_batch`), the task body must satisfy **all** of:

### 1. AC has a verifiable shell command

`## Acceptance` (or `## Acceptance Criteria`) section must contain at least one of:
- A line with `pnpm <subcommand>` (e.g. `pnpm run lint`, `pnpm test`)
- A line with `node <script>` (e.g. `node scripts/migrate.mjs`)
- A fenced ` ```bash ` code block

Why: a shell command is the cheapest objective verification. "AC says run X, X exits 0, AC passes." No ambiguity.

### 2. File Pointers section with ≥1 concrete path

`## File Pointers` section must contain at least one path-looking token (matches `*.ts`, `*.tsx`, `*.js`, `*.mjs`, `*.cjs`, `*.mts`, `*.json`, `*.md`, `*.sh`, `*.yml`, `*.yaml`).

Why: tasks without file pointers force the executor to grep-search the codebase for what to touch. That search step is where misinterpretation creeps in.

### 3. Scope ≤ 3 hours

`## Scope` section must contain a parseable hour estimate. Accepted formats: `2h`, `~2h`, `1.5h`, `2-3h`, `2–4h` (en-dash). For ranges, the **upper bound** is checked against the 3h ceiling.

Why: 3h is roughly one focused work block. Beyond that, spawn cost amortization and risk of mid-execution context loss go up. Larger work should be broken down before being marked auto-safe.

### 4. Smoke step required for build-coupled tasks

If the task body mentions any of `build:mcp`, `loader`, or `asset cop[y/ies]` (case-insensitive), the AC must include either:
- A line containing the word `smoke` (case-insensitive), or
- A line containing `pnpm run build:mcp`

Why: per feedback memory `ac_post_build_smoke` — features that depend on the bundled MCP runtime can pass unit tests but fail at runtime if the bundle isn't rebuilt or the asset isn't copied. The smoke step forces the post-build verification.

## Validator API

```ts
import { validateAutoSafeTask, AUTO_SAFE_LABEL } from 'src/core/domain/auto-safe-validator'

const result = validateAutoSafeTask(task)
// { valid: boolean, errors: string[] }
```

Pure function — reads `task.body` only, no DB access. Safe to call from anywhere.

## Enforcement timing

The validator is invoked at exactly two points in the execution chain:

### At label-add (mutation gate)

`task_update` and `tasks_update_batch` enforce the contract via `enforceAutoSafe()` in `src/adapters/mcp/mcp-tools/task-tools.ts`:

1. Hook fires only when the incoming `labels` array contains `auto-safe`.
2. **Skip if the current task already has the label** (idempotent re-update — avoids re-validating tasks that are mid-execution or DONE).
3. Probe = current task with body overridden by incoming `body` if provided (so a single update call can fix the body and apply the label atomically).
4. If validation fails, throw with all errors listed — caller sees exactly what's missing.

**Implication of rule 2**: A body-only `task_update` on a task that already carries `auto-safe` (no `labels` field in the payload, or `labels` field that still includes `auto-safe`) does NOT re-run the validator. The body can diverge from the contract at mutation time. The queue re-validation below is the only enforcement that catches this.

Other tools that mutate labels (e.g. import scripts, batch reassignment) **do not** route through this hook; they bypass the validator by design (treat them as administrative). If a future tool route adds label mutation, it must call `enforceAutoSafe` explicitly.

### At queue pick-up (READY tasks only)

`collectEligibleTasks()` in `src/core/domain/lifecycle/queue-lifecycle-service.ts` re-runs `validateAutoSafeTask(t).valid` on every candidate before spawning. A task with `auto-safe` whose body no longer satisfies the contract is silently excluded from the eligible set — it will not be executed until the body is corrected and the task re-queued.

This means: if a body edit on a READY task invalidates the contract, the queue sweep catches it even though the mutation gate was bypassed.

### After task completion

No enforcement runs on tasks in terminal states (DONE, FAILED, CANCELLED). Body edits after a task completes may leave the body in a state that would fail the validator (e.g., adding post-execution notes that replace the scope hour line). This is **intentional and harmless** — the label is informational at that point and the task will never be re-queued.

## Out of scope

- **No runner / orchestrator.** This spec describes only the contract and its enforcement on `task_update`. Whether/when to spawn an executor is a separate decision (see ADR-017 for the spawn primitive choice).
- **No retroactive validation.** Existing tasks with `auto-safe` already on them are not re-validated when this validator ships. The label sticks until next mutation.
- **No post-completion body re-validation.** Body edits on DONE/FAILED/CANCELLED tasks are not re-validated. See "After task completion" above.
- **No knowledge-base scrubbing.** This validator does not check whether referenced files exist on disk — the label is a *self-attestation* by the task author, not a static analysis.

## Revisit when

- 2-4 weeks of usage data shows specific contract gaps (e.g. tasks pass the validator but routinely fail in `/team` runs — tighten the contract).
- A specific build-coupled trigger keyword (beyond `build:mcp`/`loader`/`asset copy`) becomes a recurring source of unsmoked failures.
- The 3h scope ceiling is consistently bumped against — re-evaluate whether the granularity assumption is right.

## Related

- ADR-017: headless spawn strategy — orthogonal, applies if/when an autonomous runner is built.
- TASK-652: implementation task.
- Feedback memory `ac_post_build_smoke` — origin of the smoke-step requirement.
- Audit: `docs/knowledge/auto-safe-validator-audit-2026-05-11.md` — TASK-704 bypass investigation (verdict: spec leak by design, no code fix).
