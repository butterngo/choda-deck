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
- **Effort-band coverage: LOW.** The band is a pre-authored field, not a read-time derivation.
  Without it the CEO's single most business-relevant question is unanswerable. This is the honest
  ceiling of Pillar 5 as built.
- **Role isolation (M3): HIGH.** CEO never sees code; dev gets pointers; tester guards spared
  verbatim AC. Structural guards held on a second cluster.

> TASK-999 owns freezing ADR-NNN and should record these three confidence lines in §6, plus the
> two findings above as open questions / follow-ups.
