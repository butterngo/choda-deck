---
type: audit
title: auto-safe validator audit — TASK-704 bypass investigation
date: 2026-05-11
convRef: CONV-1778483640100-2
---

# auto-safe validator audit — 2026-05-11

Triggered by CONV-1778483640100-2: Claude-2 observed that TASK-704's current body has no parseable hour pattern in `## Scope`, yet the task carries `auto-safe` and reached status `DONE` via the queue. This audit determines: validator bug or spec-leak-by-design?

## 1. Caller map

`validateAutoSafeTask` is invoked at three points:

| Call site | File | Line | When it fires | Re-validates body after label set? |
|---|---|---|---|---|
| `enforceAutoSafe()` | `src/adapters/mcp/mcp-tools/task-tools.ts` | 218 | `task_update` / `tasks_update_batch` — only when `input.labels` includes `auto-safe` AND `current.labels` does NOT already include `auto-safe` | **No** — skips if task already has the label |
| `collectEligibleTasks()` | `src/core/domain/lifecycle/queue-lifecycle-service.ts` | 375 | Queue sweep — every cycle, before spawning | **Yes** — re-validates every READY task at pick-up |
| `validateLabelGate()` | `src/adapters/cli/commands/run.ts` | 325 | CLI `run` command gate (FE tasks) | Yes — at-run |

**Critical gap in `enforceAutoSafe`**: it returns early (line 210) if `input.labels` does not include `auto-safe`, and returns early (line 213) if the task already has `auto-safe`. This means a body-only `task_update` (no `labels` field) on a task that already has `auto-safe` bypasses the validator entirely at mutation time. The queue re-validation at `collectEligibleTasks` is the only safety net for READY tasks.

## 2. TASK-704 timeline reconstruction

From DB query on `data/database/choda-deck.db`:

| Field | Value |
|---|---|
| `status` | `DONE` |
| `labels` | `["assignee:Butter","auto-safe","metrics","adr-019","phase-2"]` |
| `created_at` | `2026-05-11T04:47:10.433Z` |
| `updated_at` | `2026-05-11T07:00:18.422Z` |

Label `auto-safe` was added per CONV-1778480097900-8 decision at **06:22**. The queue ran and completed the task. The body's `updated_at` is **07:00:18** — 38 minutes AFTER label add.

The current `## Scope` section reads:
> Implement 7 metrics logging vào `queue-run.json` artifact ở per-queue scope. Không build Option E/C/F/G — chỉ ship observability để 1 tuần sau có data ra quyết định.

No `h`-pattern. `parseScopeHours` returns `null` on this text → `validateAutoSafeTask` would return `valid: false`.

**Bypass mechanism**: The body was edited AFTER the queue executed and completed the task. At time of label add (06:22) and queue pick-up, the body contained a valid hour estimate. `collectEligibleTasks` re-validated it and it passed. The post-execution body edit (07:00:18 — adding Dogfood notes, Known gaps, etc.) removed or replaced the scope hour line. The task was already DONE; no further enforcement runs on completed tasks.

**This is not a queue bypass** — the queue ran correctly on a valid body. The invalid state is post-hoc and harmless (task is DONE).

## 3. Regex coverage

`parseScopeHours` implementation (`auto-safe-validator.ts:89-93`):

```ts
const match = /(\d+(?:\.\d+)?)\s*(?:[-–]\s*(\d+(?:\.\d+)?))?\s*h\b/i.exec(section)
```

Pattern × match table:

| Input | Matches? | Reason |
|---|---|---|
| `~3h` | ✓ | `3h` → `h` followed by end/space → `\b` holds |
| `3h` | ✓ | direct match |
| `2-3h` | ✓ | range group captures lower=2, upper=3; returns 3 |
| `2–4h` (en-dash) | ✓ | `[-–]` covers en-dash |
| `1.5h` | ✓ | `\d+(?:\.\d+)?` captures `1.5` |
| `3h estimate` | ✓ | `h` followed by space → `\b` holds |
| `~1h` | ✓ | tilde is not a word char; `1h\b` matches |
| `3 hour` | ✗ | `h` in `hour` is followed by `o` (word char) → `\b` fails |
| `1 hour` | ✗ | same; `\b` fails between `h` and `o` |
| `3 hours` | ✗ | same; `h` in `hours` followed by `o` |

**All patterns listed in the spec** (`2h`, `~2h`, `1.5h`, `2-3h`, `2–4h`) match correctly. The regex does NOT match English natural-language forms (`X hour`, `X hours`) — but those are not in the spec's accepted-format list, so this is correct behavior, not a bug.

TASK-704's scope section contains none of these patterns, confirming `parseScopeHours` returns `null` on the current body.

## 4. Verdict

**Spec leak by design** — not a validator bug.

The enforcement chain works correctly:
- Label-add time: validator runs on the body at that moment (body was valid at 06:22).
- Queue pick-up: re-validates; task was READY with valid body → eligible.
- Post-execution: task transitions to DONE; no further enforcement needed or intended.

The "leak" is that the spec's Out-of-scope section says "No retroactive validation" for the initial ship, but does not explicitly document the post-completion body-edit case. A maintainer reading the spec could reasonably ask "what happens if I edit the body of a DONE auto-safe task?" — and find no answer.

**No code fix required.** The spec requires an amendment to document:
1. Enforcement timing explicitly (at-mutation label-add AND at-queue-pickup for READY tasks only).
2. Post-completion body edits are not re-validated; any stale-invalid state is harmless.
3. The `enforceAutoSafe` idempotent-skip design decision and its implication for body-only updates.

See ADR amendment below (applied to `docs/knowledge/auto-safe-label-spec.md`).

## 5. Test coverage gaps

The existing test suite (`auto-safe-validator.test.ts`) covers the validator in isolation. It does NOT cover:
- `enforceAutoSafe` body-only-update bypass path (integration test needed in task-tools tests)
- `collectEligibleTasks` filtering invalid body after label set (covered in `queue-lifecycle-service.test.ts:175` for missing AC, but not for scope-hour-missing)

These are documentation/test gaps, not execution bugs. No AC required for this audit.
