---
type: decision
title: "ADR-025: knowledge_register_existing — keep as-is, error rate is noise"
projectId: choda-deck
scope: project
refs:
  - path: src/adapters/mcp/mcp-tools/knowledge-tools.ts
    commitSha: 667ebdfb8e95362443f46096a0ca3c4afe4f129a
  - path: src/core/domain/knowledge-service.ts
    commitSha: 667ebdfb8e95362443f46096a0ca3c4afe4f129a
  - path: src/core/domain/knowledge-frontmatter.ts
    commitSha: 667ebdfb8e95362443f46096a0ca3c4afe4f129a
  - path: src/core/domain/stats-service.ts
    commitSha: 667ebdfb8e95362443f46096a0ca3c4afe4f129a
createdAt: 2026-05-19
lastVerifiedAt: 2026-05-19
---

> AI-Context: `knowledge_register_existing` showed 66.7% error rate (2/3 calls) in stats_report 2026-05-08→2026-05-15. Investigation: all 3 calls came from one user iterating in a 3-minute window (14:18 fail → 14:20 fail → 14:21 success), both failures = `FrontmatterParseError` with precise error messages. N=3 is below the classifier floor (FLOOR_CALLS=5) so the tool is already classified `emerging`, not `broken`. No fix needed — the parser is doing its job and the iteration loop is normal.

## Context

TASK-828 flagged `knowledge_register_existing` for a 66.7% error rate in a 7-day window. Raw data from `tool_invocations`:

| ts | ok | duration_ms | error_kind |
|---|---|---|---|
| 2026-05-11T14:18:44Z | 0 | 3 | FrontmatterParseError |
| 2026-05-11T14:20:52Z | 0 | 2 | FrontmatterParseError |
| 2026-05-11T14:21:07Z | 1 | 4775 | — |

All 3 calls on the same day, in a 3-minute window. Tool hasn't been called since.

The parser ([[knowledge-frontmatter.ts]]) is strict — requires `type`, `title`, `projectId`, `scope`, `createdAt`, `lastVerifiedAt` and rejects unknown keys. Error messages name the specific missing/invalid field. Pattern fail → fail → success in 3 minutes = user iterating to match the schema, exactly what the precise error messages are designed to support.

## Decision

**Keep `knowledge_register_existing` as-is. No code change.**

Reasoning:

1. **Root cause is not a bug.** Failures = strict frontmatter validation rejecting incomplete user input. Error messages already name the bad field. The user fixed it in 2 iterations.
2. **N=3 is below the classifier floor.** `stats-service.ts:9` sets `FLOOR_CALLS=5` — a tool with <5 calls cannot be classified `broken` regardless of error rate. The task was triggered by raw error rate from the report's per-tool table, not by the `brokenTools` classification.
3. **Use case is inherently sparse.** Tool exists for one-time ADR backfill (e.g. ingesting `workflow-engine` ADRs into an `automation-rule` workspace). 3 calls/all-time is not "broken", it's "rarely needed and currently dormant".
4. **No worktree-guard interaction.** Hypothesis from task body (TASK-685/686 worktree guard blocking register-existing) is wrong — failures are pure parse errors, not guard rejections.

## Why not other options

| Option | Rejected because |
|---|---|
| Deprecate / remove tool | Would force users to hand-edit SQLite for ADR backfill. Use case is real, just sparse. |
| Redesign for laxer validation | Strict validation is the point — index must not accept ADRs with missing/wrong frontmatter, or `knowledge_list` rows would lie about `lastVerifiedAt`. |
| Add preflight schema hint to tool description | Possible follow-up if a future user hits the same iteration loop. Defer until a second user actually trips on it — speculative API change. |
| Fix error message to include the full required template | Already does — `FrontmatterParseError` names the specific bad key. Adding a wall-of-text template would noise up the response for the common case of one missing key. |

## Consequences

- **Good:** Zero code change. Tool stays available for the rare backfill case. Stats classifier will stop surfacing this once N stays ≤5 and either error rate drops or the classifier's noise floor does its job. Task closes with documented rationale.
- **Bad:** Future stats_report readers may spot the 67% error rate again and re-open the question. Mitigation: this ADR is the answer — link it from any follow-up.
- **Neutral:** Tool description does not change. If a third user iterates against the parser, that's still 3-call N — within tolerance.

## Revisit when

- Tool reaches N≥5 calls in a 7-day window AND error rate >20% → classifier flags as `broken` → real signal, re-investigate.
- A user reports the iteration loop is painful (vs. fail-once-then-succeed which is fine).
- Frontmatter schema changes (new required field added) → tool description must be updated synchronously to avoid stale-doc-induced failures.

## Related

- [[ADR-018-knowledge-layer]] — defines the frontmatter schema this tool validates against.
- [[ADR-022-workspace-scoped-knowledge]] — adds `workspaceId` to frontmatter, which `registerExistingKnowledge` cross-checks against the input (line `knowledge-service.ts:176`).
- TASK-681 — MCP tool usage stats that surfaced this. `FLOOR_CALLS=5` was added precisely to avoid this kind of N=3 false positive.
- TASK-685 / TASK-686 — worktree-safe knowledge lifecycle. Confirmed NOT involved in the failures.
