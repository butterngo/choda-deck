---
type: decision
title: "ADR-033: Deprecate graphify — retire the AST code-graph enrichment, do not fold into the unified store"
projectId: choda-deck
scope: project
refs:
  - path: src/adapters/mcp/mcp-tools/task-context-graphify.ts
    commitSha: 0a6ec658d6ad7d5a65d78ea54d7f9d73aa8eaa32
  - path: src/adapters/mcp/mcp-tools/task-tools.ts
    commitSha: 0a6ec658d6ad7d5a65d78ea54d7f9d73aa8eaa32
  - path: docs/knowledge/ADR-016-graphify-integration.md
    commitSha: 0a6ec658d6ad7d5a65d78ea54d7f9d73aa8eaa32
createdAt: 2026-06-04
lastVerifiedAt: 2026-06-04
---

# ADR-033: Deprecate graphify — retire the AST code-graph enrichment, do not fold into the unified store

> AI-Context: "graphify" is an external LLM/AST tool that emits `graphify-out/graph.json` — a code-symbol graph (functions, imports, calls). choda-deck consumes it in exactly one runtime path: `task_context` appends a `graphify_context` block (`affected_files`, `god_nodes`, `affected_communities`, staleness) via `buildGraphifyContext()`. This ADR resolves ADR-032 §6's deferred "deprecate graphify — split or fold?" question. **Decision: SPLIT + RETIRE** — remove the enrichment and the `graph.json` artifacts; do **not** fold graphify into the unified SQLite graph, because the unified graph has no AST layer to fold it into. Execution is TASK-991; this ADR is decision-only.

## Context

ADR-032 (Unified Knowledge Graph v2) §6 carried one unresolved execution question from two pilots: *"Deprecate graphify — split out (recommended) or fold into this one?"* The pilots ran B0→B4 end-to-end without graphify and didn't miss it. This ADR answers the question with a consumer audit of the live tree and commits to a migration + sunset.

Three facts drive the decision:

1. **graphify_context is AST-derived, the unified graph is not.** `task-context-graphify.ts` does a file-based BFS over a graph whose edges are `imports_from | calls | contains | method | implements | references` between **code symbols** (`task-context-graphify.ts:52-59`). The unified SQLite graph (P1/P2) stores task / feature / gotcha / `code_ref` nodes joined by `REALIZES | ABOUT | IN | TOUCHES` at **file/symbol-pointer** granularity — there is no call-graph or import-graph layer. So `god_nodes` (degree over the call graph) and `affected_communities` (Louvain over the AST graph) **cannot be re-derived** from the unified store. "Fold into the unified store" is not a like-for-like replacement; it would mean building an AST extractor choda-deck doesn't have and ADR-032 never scoped.

2. **The enrichment has been silently degrading.** ADR-016 shipped graphify as *Phase 1, manual-refresh only*; Phases 2/3 (auto-refresh on `session_end`, upstream `_rebuild_code` fixes) never shipped. The live `graph.json` is **~19.5 days stale** (`graph_is_stale: true` on every `task_context` call — observed in TASK-989's own context block). Since there is no refresh path, the signal only decays.

3. **The actionable subset is already served by P2.** The one part of `graphify_context` a planner acts on — "which files does this task touch?" — is delivered first-class by the shipped `code_ref` / `TOUCHES` layer (`task_touches`, the `feature` node `REALIZES → TOUCHES → code_ref` chain). `god_nodes` / `communities` are situational-awareness extras that the pilots never consumed.

## Decision

**Split out as its own deprecation (this ADR), then RETIRE the graphify integration entirely. Do not fold it into the unified store.**

- Remove the `graphify_context` enrichment from `task_context` — delete `buildGraphifyContext` and unwire it from `task-tools.ts`.
- Delete the `graphify-out/` artifacts (graph.json + cache) and their ignore entries.
- Supersede ADR-016; the graphify skill is decommissioned as a choda-deck dependency.
- **No replacement built.** If structural code-awareness is wanted later, it is new scoped work against the unified graph (an AST `code_ref` extractor), not a graphify port — filed separately if/when the need is concrete.

## Consumer inventory (AC #2 — confirmed against `0a6ec65`)

| Consumer | Kind | Load-bearing? | Disposition (TASK-991) |
|---|---|---|---|
| `src/adapters/mcp/mcp-tools/task-context-graphify.ts` (+ `__tests__/task-context-graphify.test.ts`) | runtime module | **Yes** — sole producer of `graphify_context` | Delete module + test |
| `src/adapters/mcp/mcp-tools/task-tools.ts:10,74,84` | runtime wiring | **Yes** — imports + calls it, adds `graphify_context` to the `task_context` payload | Remove import, call, and payload field |
| `graphify-out/graph.json` + `graphify-out/cache/*` | artifact | runtime input (stale) | Delete directory |
| `.gitignore`, `.dockerignore` (`graphify-out/` entries) | config | no | Drop the entries |
| `scripts/spike-graphify-query.ts` | dev spike | no — one-off port validation, not in any runtime path | Delete |
| `CLAUDE.md` (Code graph section), `docs/architecture.md` | docs | no | Update — drop graphify references |
| `docs/knowledge/ADR-016-graphify-integration.md` | ADR | no | Flip status → SUPERSEDED by ADR-033 |
| `docs/knowledge/INDEX.md`, `docs/knowledge/ADR-032` (mention) | index/ref | no | Re-index; ADR-032 mention stays (historical) |
| `~/.claude/skills/graphify/SKILL.md` | user-global skill | no — not in repo | Out of repo scope; note as decommissioned |

**Not consumers (grep false positives, called out to prevent mis-deletion):**

- `scripts/export-graph.mjs` — renders the **knowledge** graph (`knowledge-graph-out/`); its header explicitly contrasts itself with graphify. Leave untouched.
- `src/core/domain/remote-operations.interface.ts`, `repositories/postgres/workspace-repository.pg.ts` — only **comments** mention "task_context's graphify block". The methods (`getProject`, `findWorkspaces`) also serve `project_list` and the stdio facade, so they stay; only the stale comments get updated.

Confirmed: **no graphify consumer is load-bearing for an active workflow** beyond the `task_context` enrichment itself, which the pilots ran without.

## Migration plan (AC #3)

- **`graphify-out/graph.json` + `cache/`**: **delete** (do not archive). It is a regenerable, already-19-day-stale AST artifact with no historical value; the last semantic-rich rebuild was lost in the ADR-016 Spike 2 clobber anyway. Removal drops the gitignored directory; nothing in git history is touched.
- **`task_context` consumers**: the `graphify_context` field becomes absent. It was already optional/typed as `GraphifyContext | GraphifyNotAvailable` and frequently returned `{ status: 'no-graph' }`, so consumers already tolerate its absence — no breaking-change handling needed.
- **Skill**: remove the `/graphify` setup note from README/CLAUDE.md; the user-global skill file can stay on disk (harmless) but is no longer referenced.
- **Sequencing**: this ADR (033, ACCEPTED) → TASK-991 executes the removals in one PR → ADR-016 flips to SUPERSEDED in the same PR.

## Sunset

**Target: TASK-991 lands by 2026-06-18.** On merge, graphify is fully removed from the runtime tree and ADR-016 is SUPERSEDED. No deprecation-window/dual-run period is needed — the enrichment is non-load-bearing and already failing-stale, so there is nothing to wind down gracefully.

## Consequences

**Positive**
- `task_context` stops shipping silently-stale AST context that reads as fresh.
- One external Python/AST dependency (graphify + its Windows-broken refresh path, ADR-016 Phase 2/3) leaves the critical path entirely.
- The unified graph becomes the single, honest source of code-coupling signal (via `code_ref`/`TOUCHES`) — no competing half-maintained graph.

**Negative / accepted tradeoffs**
- Loss of `god_nodes` / `affected_communities` situational signal in planning. Accepted: it was never consumed in the pilots, was AST-only, and was decaying with no refresh path.
- A future desire for structural code-awareness must be built fresh against the unified store, not recovered by un-deprecating graphify.

## Revisit when

- TASK-991 merges — flip this ADR's "execution is TASK-991" language and ADR-016's status to past tense.
- A concrete need for call-graph / import-graph awareness resurfaces — scope an AST `code_ref` extractor against the unified store as new work; do not resurrect graphify.

## Related

- [[ADR-032-unified-knowledge-graph-v2]] — §6 deferred this question (P1 — unified store); this ADR is its answer
- [[ADR-016-graphify-integration]] — the Phase-1 query-only integration this deprecates (→ SUPERSEDED on TASK-991 merge)
- TASK-989 — this decision ADR (P1-DEP); TASK-991 — execution (P1-EXEC, blocked on this)
- `src/adapters/mcp/mcp-tools/task-context-graphify.ts` — the module being retired
- `code_ref` / `TOUCHES` layer (P2) — the shipped replacement for the actionable subset

---

**Status: ACCEPTED — ADR-033 (2026-06-04).** Resolves ADR-032 §6 (deprecate graphify: SPLIT + RETIRE). Execution carried by TASK-991. Register via `knowledge_register_existing`.
