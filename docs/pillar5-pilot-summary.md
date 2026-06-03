# Pillar 5 (read-time role projection) — pilot summary

Persisted evidence for ADR-NNN Pillar 5 (`feature_projection`). Two pilots:

- **PILOT-1** — PIM feature `feature-crawler-list-ui-enhancements` (TASK-994 baseline).
- **PILOT-2** — choda-deck feature `feature-readtime-role-projection` (TASK-996, this doc).

> **Why this file exists:** PILOT-1's `PILOT-SUMMARY.md` and `PILOT-B4-REPLAY.md` were
> referenced by the task AC and by `feature-projection-replay.test.ts` but were **never
> committed** — the B1–B4 protocol and the M1–M4 baseline lived only in the TASK-994 working
> session. This file reconstructs the protocol from `scripts/migrate-988-pilot-proxies.mjs`,
> `scripts/migrate-992-pilot-edges.mjs`, and the replay test, and records both pilots side by
> side so the evidence survives the session.

## Protocol (B0–B4)

| Stage | What it does |
|-------|--------------|
| **B0** | Seed project context (e.g. `pim-project-context-seed.md`). |
| **B1** | Author the `feature` node: `realizesTasks`, `inWorkspaces`, `status` — and, in PILOT-1 only, a pre-authored `effortBand` (the honesty caveat PILOT-2 removes). |
| **B2** | Author `gotcha` nodes with `affectedFeatureId` → ABOUT edges. |
| **B3** | Author `code_ref` rows + TOUCHES edges on the realized tasks (dev role's pointers). |
| **B4** | Run `feature_projection(featureId, role)` for `ceo-po` / `dev` / `tester`; score M1–M4. |

Edges (`REALIZES`, `IN`, `ABOUT`) are now auto-wired by `knowledge_create` from structured
frontmatter — the migrate-992 backfill is no longer needed for fresh nodes.

## Measurements

| Metric | Definition | Pass bar |
|--------|------------|----------|
| **M1** | Self-serve rate — questions a role answers from the graph with no human | ≥ 6/7 yes |
| **M2** | Gotcha recall fire-rate — gotchas surfaced *before* the dev's first question | ≥ 1 |
| **M3** | Role bleed — code symbols in CEO view / missing code_refs in dev view | 0 |
| **M4** | Effort-band fidelity — CEO answer must NEVER contain a number-of-days | 0 day-counts |

## PILOT-2 — the honesty condition

`feature-readtime-role-projection` was authored with **no `effortBand`** (the `## Effort band`
section is deliberately blank). The PIM pilot's biggest caveat was that CEO Q3 (effort) leaned
on a band pre-written at feature-creation time. PILOT-2 asks: what does the projection do for
the effort question when nothing is pre-authored?

### Scorecard (run 2026-06-02, live choda-deck graph)

| Metric | Result | Verdict |
|--------|--------|---------|
| **M1** | 6/7 — the single NO is **CEO Q3 (effort band)** | ✅ at bar, and the one gap is the band, as predicted |
| **M2** | 2 gotchas recalled before first dev question | ✅ |
| **M3** | CEO view exposes no `codeRefs` and no symbols; dev view carries 5 TOUCHES pointers; tester derived surfaces threw no guard error | ✅ 0 bleed |
| **M4** | CEO `effortBand: null` — no day-count anywhere | ✅ (band absent, not fabricated) |

> **Re-run after TASK-1025 (2026-06-03):** with read-time derivation shipped, the same
> no-band cluster now answers CEO Q3 — **M1 rises to 7/7**. See "Re-run" below.

### Key finding 1 — the band fails *safe*, not *silent*

With no pre-authored band the projection returns:

```json
"effortBand": null,
"honesty": { "lacked": ["team-boundaries", "effort-band"] }
```

The projection **does not derive and does not fabricate** — it returns `null` and the honesty
section explicitly names `effort-band` under `lacked`. This is the desired fail-safe: a CEO
asking "how big is this?" gets an honest "unknown from the graph," never a made-up number.

**The real Pillar-5 limit (documented, not a failure — AC #6):** the effort band is *only* as
good as what a human pre-authored on the feature node. `feature-projection.ts:203` is literally
`effortBand: input.effortBand ?? null` — there is **no read-time derivation**. CEO Q3 is
unanswerable from raw task-body evidence today. Closing that gap is a *separate, scoped feature*
(see follow-up), not part of this honesty pilot.

> **CLOSED by TASK-1025 (2026-06-03).** `projectCeo` now calls `deriveEffortBand()` when no band
> is pre-authored: a base band from realized-task **count**, bumped one notch for an epic label, a
> heavy spec surface (≥15 AC items), or blocked work (max `blockedBy` ≥ 2), clamped at XL. The
> CEO view carries `effortBandSource: 'authored' | 'derived' | null` and a counts-only
> `effortBandReasoning` string (passes `assertNoNumberOfDays`, so M4 still holds). A human-authored
> band still wins (override); zero realized tasks still returns `null` (fails safe, not fabricated).

## Re-run — PILOT-2 with derivation (2026-06-03, live choda-deck graph)

Post-`build:mcp` stdio smoke against the same `feature-readtime-role-projection` node (still no
authored band):

```json
"effortBand": "L",
"effortBandSource": "derived",
"effortBandReasoning": "2 realized tasks (base M); +1 blocked work (2 blockers)",
"honesty": { "used": ["…", "effort-band (derived)"], "lacked": ["team-boundaries"] }
```

CEO Q3 flips **NO → YES**: a derived band **L** with shown reasoning, and `effort-band` is no
longer under `honesty.lacked`. **M1 = 7/7.** M3 still 0 (CEO view exposes no `codeRefs` field);
M4 still 0 day-counts (reasoning is counts of tasks/AC/blockers, never a duration).

### Key finding 2 — gotchas are mislabeled as "blockers" in the CEO view

`projectCeo` maps **every** gotcha into the CEO `blockers` field
(`feature-projection.ts:207` — `blockers: input.gotchas.map(...)`). For PILOT-2's `shipped`
feature with zero real blockers, the two gotchas surface to the CEO as "blockers," implying the
shipped feature is blocked. Titles-only, so no M3 symbol bleed — but a semantic honesty problem:
a *concern* is not a *blocker*, and a `shipped` feature should report no blockers. Filed as a
follow-up.

## Confidence (for TASK-999 to fold into ADR-NNN §6)

- **Honesty mechanism: HIGH.** Across two independent clusters the projection never fabricated a
  missing field; the `honesty.used/lacked` contract held and correctly flagged the absent band.
- **Effort-band coverage: ~~LOW~~ → MEDIUM (TASK-1025, 2026-06-03).** No longer a pure
  pre-authored field — `deriveEffortBand()` answers CEO Q3 at read-time from realized-task signal
  with shown reasoning, and flags the band as `derived` vs `authored` so the estimate is never
  passed off as human judgment. Coverage is MEDIUM not HIGH because the heuristic is a structural
  proxy (count + labels + AC volume + blocker breadth), not a calibrated estimate; a wrong derived
  band is now possible and is itself a documentable limit, but it fails *visibly* (source +
  reasoning shown), not silently.
- **Role isolation (M3): HIGH.** CEO never sees code; dev gets pointers; tester guards spared
  verbatim AC. Structural guards held on a second cluster.

> TASK-999 owns freezing ADR-NNN and should record these three confidence lines in §6, plus the
> two findings above as open questions / follow-ups.
