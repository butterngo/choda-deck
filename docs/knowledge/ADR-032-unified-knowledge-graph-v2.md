---
type: decision
title: "ADR-032: Unified Knowledge Graph v2 — program consolidation, §6 resolutions, ACCEPTED"
projectId: choda-deck
scope: project
refs:
  - path: src/core/domain/knowledge-types.ts
    commitSha: aea86b1042a01d5ea75a5db8f1ec41e966e02cae
  - path: src/core/domain/task-types.ts
    commitSha: aea86b1042a01d5ea75a5db8f1ec41e966e02cae
  - path: src/core/domain/services/feature-projection.ts
    commitSha: aea86b1042a01d5ea75a5db8f1ec41e966e02cae
  - path: docs/pillar5-pilot-summary.md
    commitSha: aea86b1042a01d5ea75a5db8f1ec41e966e02cae
createdAt: 2026-06-03
lastVerifiedAt: 2026-06-03
---

# ADR-032: Unified Knowledge Graph v2 — program consolidation, §6 resolutions, ACCEPTED

> AI-Context: The "unified knowledge graph v2" is choda-deck's single SQLite-backed graph of typed knowledge **nodes** (`spike | decision | postmortem | learning | evaluation | feature | code_ref | gotcha`) joined by typed **edges** (`REALIZES | ABOUT | IN | DEPENDS_ON | DECIDED_BY | PINS | IMPLEMENTS | USES_TECH | INTEGRATES_WITH`, plus the code_ref `TOUCHES` relation), replacing graphify's separate `graph.json`. The per-area design ships in ADR-018/020/022/023/026/028–031 and the pilot summary — **this ADR does not re-host those specs**; it ratifies the program, resolves the six §6 open questions from two pilots, fixes the ADR number (032; ADR-031 stays session-end), and flips the program status PROPOSED → ACCEPTED.

## Context

The unified-knowledge-graph-v2 program ran as a numbered set of "pillars" (P1 unified store, P2 code_ref layer, P5 read-time projection, P6 inbox), validated through two pilots on live data (PIM `feature-crawler-list-ui-enhancements`, choda-deck `feature-readtime-role-projection`). Its planning document — `ADR-NNN-unified-knowledge-graph-v2` with a §6 open-questions section — **was never persisted as a file** (the same fate as PILOT-1's `PILOT-SUMMARY.md`, which TASK-996 reconstructed into `docs/pillar5-pilot-summary.md`). It survived only as references from task bodies and pilot nodes.

TASK-999 is the meta-task that freezes that program: resolve §6, assign a real ADR number, flip PROPOSED → ACCEPTED, and calibrate the Pillar-5 confidence against pilot evidence. With no source file to edit, this ADR **reconstructs the decisions from the surviving authoritative sources** — the §6 verdict table carried verbatim in the TASK-999 body, `docs/pillar5-pilot-summary.md`, the shipped schema, and the per-area ADRs — rather than re-deriving lost pillar prose. It is a *consolidation* ADR: it records what shipped and what was decided, and points to where each pillar's detail actually lives.

## The graph primitives (as shipped — grounding for this ADR)

| Primitive | Values | Source of truth |
|---|---|---|
| Node types | `spike, decision, postmortem, learning, evaluation, feature, code_ref, gotcha` | `knowledge-types.ts` `KnowledgeType` |
| Edge types | `DEPENDS_ON, IMPLEMENTS, USES_TECH, DECIDED_BY, REALIZES, ABOUT, PINS, IN, INTEGRATES_WITH` | `task-types.ts` `RelationType` |
| code_ref edge | `TOUCHES` (task ↔ code_ref, carries `modifies | reference` relation) | `code-ref-types.ts` |
| `feature` node frontmatter | `realizesTasks[]` → REALIZES, `inWorkspaces[]` → IN, `affectedFeatureId` (gotcha) → ABOUT, `status`, `effortBand?` | `knowledge_create` auto-wires edges from structured frontmatter |

Edges are auto-wired by `knowledge_create` from structured frontmatter (the migrate-992 backfill is obsolete for fresh nodes). The graph is the single SQLite store; there is no separate graphify `graph.json` in the v2 model (P1).

## Pillar program map (where each pillar's detail lives)

| Pillar | What it is | Status | Authoritative detail |
|---|---|---|---|
| **P1 — Unified store** | One SQLite graph; deprecate graphify's separate `graph.json` | Decided; execution open | TASK-989 (deprecation ADR), TASK-991 (execute) — label `p1-unified-store` |
| **P2 — code_ref / TOUCHES** | Code anchors via REALIZES → TOUCHES → `code_ref`; full-dotted-symbol rule (Pillar 2c) for deep namespaces; line-drift tolerance | Shipped + pilot-confirmed | `code-ref-tools.ts`; B1 claim confirmed on live PIM data |
| **P5 — Read-time role projection** | One feature node → CEO/dev/tester views with structural M3/M4 guards + honesty section | Shipped | ADR Pillar-5 in `feature-projection.ts`; TASK-994/995/996/1025; `docs/pillar5-pilot-summary.md` |
| **P6 — Inbox** | Workspace-nullable inbox + progressive localization | Open | TASK-993 — label `p6-inbox` |

> The original program also used intermediate pillar numbers (P3/P4) whose prose did not survive in any persisted file. This consolidation does **not** invent them — the per-area ADRs (018 knowledge layer, 020 embeddings, 022 workspace-scoped knowledge, 023 agent memory, 026 dual-transport, 028–031 session flow) carry the cross-cutting design that the pillar framing summarised. If a recovered P3/P4 spec resurfaces, file it as a follow-up; it does not block this ratification.

## §6 open questions — resolved

Carried from the TASK-999 body (the authoritative verdict table), with pilot evidence:

| §6 question | Resolution | Carried into |
|---|---|---|
| Deprecate graphify — split or fold? | **Split** — no consumer needed graphify during the B0–B4 pilots | TASK-989 (P1-DEP), TASK-991 (P1-EXEC) |
| `feature` granularity (is an epic a feature?) | **Accept "smallest user-perceivable outcome"** — a feature node bundles multiple epics; adopt this definition in the model | This ADR (definition above) |
| gotcha promote: manual vs. auto? | **Auto-draft with manual confirm** — server emits `gotcha_draft` candidates; human gates | TASK-998 (GOTCHA-AUTO) |
| Non-tech entry point: Teams (M365) or dedicated UI? | **Undecided** — untested in pilot; defer the call | TASK-997 (NON-TECH-ENTRY) |
| Actual highest ADR number | **032** for this ADR (scan below) | This ADR §Numbering |
| ~~`code_ref` line drift~~ | Already decided in Pillar 2c — no action | — |

## Pillar-5 confidence (calibrated against both pilots)

From `docs/pillar5-pilot-summary.md`, updated after TASK-1025:

- **Honesty mechanism: HIGH.** Across two independent clusters the projection never fabricated a missing field; `honesty.used/lacked` held and correctly flagged absent data.
- **Role isolation (M3): HIGH.** CEO sees no code; dev gets pointers; tester guards spared verbatim AC. Structural guards held on a second cluster.
- **Effort-band coverage: MEDIUM** (was LOW pre-TASK-1025). `deriveEffortBand()` now answers CEO Q3 at read-time from realized-task signal and labels the band `derived` vs `authored`, so an estimate is never passed off as human judgment. MEDIUM not HIGH because the heuristic is a structural proxy (count + labels + AC volume + blocker breadth), not a calibrated estimate; a wrong band fails *visibly* (source + reasoning shown), not silently. Re-run flipped CEO Q3 NO→derived, M1 6/7 → **7/7**.

## Numbering decision

Manual scan of `docs/knowledge/` + each workspace's `docs/knowledge/` + `vault/30-Knowledge/` (per ADR-019, regex `/^ADR-(\d+)/`):

- Highest existing number = **031** (`ADR-031-session-end-derivation`, TASK-985 draft).
- **This ADR = ADR-032.** No collision: ADR-031 keeps its number (the draft does **not** need renaming — the collision risk flagged in the TASK-999 body resolves cleanly since this ADR takes 032, not 031).
- **Pre-existing hygiene debt noted (not fixed here):** duplicate numbers exist — two `ADR-019` (`adr-numbering-convention` + `autonomous-queue-runner`) and two `ADR-023` (`agent-memory-layer` + `auto-safe-v2-hardening`); `ADR-027` is referenced in `CLAUDE.md` (OAuth mode) but has no file. Filed as a separate cleanup concern; out of scope for this ratification.

## Consequences

**Positive**
- The v2 program has a durable, indexed home — the lost planning doc no longer leaves the architecture un-anchored.
- §6 is closed: each open question routes to a decision or an owning task; downstream P5/P6 work proceeds without re-litigating scope.
- ADR-031 (session-end) is confirmed conflict-free — TASK-985's provisional number stands; no file rename needed.

**Negative / accepted tradeoffs**
- This ADR consolidates rather than fully re-specifies: per-pillar detail is **referenced**, not re-hosted. Readers chasing a pillar's design follow the linked ADR / code, not this file.
- P3/P4 prose is unrecovered and deliberately not invented — a documented gap, not a silent one.

## Revisit when

- TASK-997 decides the non-tech entry point (Teams vs UI) — fold the verdict back here.
- P1 execution (TASK-991) removes graphify — update the "no `graph.json`" claim to past tense once done.
- A recovered P3/P4 spec resurfaces — register it and link from the pillar map.

## Related

- [[ADR-018-knowledge-layer]] — v1 foundation this program extends (code-coupled MD + frontmatter + staleness)
- [[ADR-019-adr-numbering-convention]] — the numbering scan rule applied above
- [[ADR-022-workspace-scoped-knowledge]] — workspace scoping of knowledge nodes (P-cross-cutting)
- [[ADR-023-agent-memory-layer]] — memory layer adjacent to the graph
- [[ADR-031-session-end-derivation]] — confirmed conflict-free at ADR-031 by this ADR's number scan
- `docs/pillar5-pilot-summary.md` — the two-pilot evidence + confidence lines lifted into §Pillar-5 confidence
- TASK-999 — this consolidation; TASK-989/991 (P1), TASK-993 (P6), TASK-997 (non-tech entry), TASK-998 (gotcha auto), TASK-1025 (effort-band derivation)

---

**Status: ACCEPTED — ADR-032 (2026-06-03).** Program ratified; §6 resolved; number frozen. Register in the knowledge index via `knowledge_register_existing`.
