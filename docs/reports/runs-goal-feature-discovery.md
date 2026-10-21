---
requirement: "có thể thêm 1 cái feature BPA 2513 tôi cần biết đây là cái feature gì có thêm cách nào cho tôi biết không"
started: 2026-10-21
workspace: Main
status: converged
---

# Discovery — Runs: tell Butter which feature a run's goal belongs to

Goal 1 of 4 (Butter, 2026-10-21; order 1 → 3 → 2 → 4). Thread: CONV-1792550694921-246.

## Round 1

### New evidence this round
| Source | What it settled | Citation |
|---|---|---|
| conversation | thread opened, no messages yet | [conversation CONV-1792550694921-246] |
| user | the ask, and that later goals (diagram/test cases, QC smoke report, deploy checklist) follow | chat 2026-10-21 |
| code | a feature's task links are REALIZES edges (task → feature) in `relationships`, derived from the feature's `realizesTasks` frontmatter ONLY when the feature is created; updateKnowledge cannot change structured fields, so there is no way to link a new goal to an existing feature | choda-deck/src/core/domain/knowledge-service.ts:229-249 |
| data | 229 REALIZES edges, 224 tasks, 43 features; the newest linked task is TASK-2162 (2026-09-27). None of TASK-2513, 2534, 2501, 2542, 2559 is linked | live DB query 2026-10-21 |
| code | `feature_projection` (ceo-po / dev / tester) exists | choda-deck/src/core/domain/services/feature-projection.ts:1-12 |
| tool | `feature_projection(journey-lead-to-delivered, ceo-po)` FAILS: "role bleed (M3) — SQL token jsonb". The CEO guard throws on any technical word in the body instead of leaving it out, so the "what is this feature" answer is unusable for a technical feature | feature-projection.ts:153,188; tool call 2026-10-21 |
| file | a feature file carries title, `realizesTasks`, `effortBand`, `status` and a "## Why this exists" section that explains it in prose | C:/dev/test/bpa-engine/docs/knowledge/journey-lead-to-delivered.md:1-25 |

### Scores
| # | Dimension | Score | Why exactly this — evidence | What it needs to reach 9 |
|---|---|---|---|---|
| 1 | Problem & value | 9 | Butter's words; no goal since 2026-09-27 is linked to a feature (DB) | — |
| 2 | Scope & boundary | 6 | in: link goal → feature, show it on Runs. Undecided: one or several features per goal, backfill of old runs, what the card shows | D1-D3 |
| 3 | Technical contract | 6 | edge store and derivation read; no write path for linking an existing feature | decide the write path (new tool vs task_update field vs feature frontmatter edit) |
| 4 | Prior art | 8 | TASK-988/992/994 feature graph and projection | knowledge_search for any ADR that rejected task→feature on the task side |
| 5 | Edges & failure | 6 | CEO projection throws on technical bodies; goal with no feature; feature deleted | decide no-feature behaviour (D2) |
| 6 | NFR | 5 | defaults apply; read-only display | walk 12 |
| 7 | Acceptance criteria | 3 | none | blocked on D1-D4 |

**TOTAL = MIN = 3** (dimension 7). New evidence: YES (6).

### Score history
| # | Dimension | R1 |
|---|---|---|
| 1 | Problem & value | 9 |
| 2 | Scope & boundary | 6 |
| 3 | Technical contract | 6 |
| 4 | Prior art | 8 |
| 5 | Edges & failure | 6 |
| 6 | NFR | 5 |
| 7 | Acceptance criteria | 3 |
| | **MIN** | **3** |

### Stop — blocked on human decisions
D1 one feature per goal, or several? D2 /choda-plan with no fitting feature: create a new feature, or leave the goal unlinked? D3 backfill the runs already on the Runs screen (TASK-2513 and others)? D4 what the run card shows about the feature.

## Round 2

### New evidence this round
| Source | What it settled | Citation |
|---|---|---|
| conversation | no human messages in the thread | [conversation CONV-1792550694921-246] |
| user | D1 exactly one feature per goal · D2 no fitting feature → /choda-plan proposes a new one, approved with the plan, so a goal never lacks a feature · D3 backfill the runs already on screen once, Butter approves a table · D4 the card shows the feature name, the opening of "Why this exists", and a link; no model call; the CEO projection error is fixed too | AskUserQuestion answers, 2026-10-21 |
| code | the service already writes edges: `addRelationship(from, to, type)` / `removeRelationship`, and reads them with `getRelationshipsFrom(itemId, type)` | choda-deck/src/core/domain/interfaces/relationship-repository.interface.ts:4-7, sqlite-task-service.ts:431 |
| code | the projection reads realized tasks from the EDGES, not the frontmatter, so an edge-only link is seen by `feature_projection` | choda-deck/src/adapters/mcp/mcp-tools/feature-projection-builder.ts:159 |
| repo | feature files live in the WORKSPACE repo (`C:/dev/test/bpa-engine/docs/knowledge/…`). Rewriting their frontmatter to add a task would dirty that repo, and autopilot refuses a dirty tree (choda-autopilot §2.1). So the link is an edge only | journey-lead-to-delivered.md path; choda-autopilot/SKILL.md §2.1 |
| code | the companion links to `#/knowledge?slug=<slug>` from two places, but KnowledgeView starts with `selectedSlug = null` and never reads the query, so the link opens the list, not the entry | companion components/TaskProvenance.tsx:55, CommitDetailPanel.tsx:97; views/KnowledgeView.tsx:28 |

### Contract settled
- **MCP `feature_link({ taskId, featureSlug, replace? })`** (choda-deck, new tool beside the knowledge tools): task must exist → else `UNKNOWN_TASK`; `featureSlug` must be a knowledge entry of type `feature` → else `UNKNOWN_FEATURE` / `NOT_A_FEATURE`; the task already REALIZES another feature and `replace` is not true → `ALREADY_LINKED` naming it; otherwise remove any other REALIZES from the task, add `taskId → featureSlug` REALIZES, return `{ taskId, featureSlug, replaced: string | null }`. Linking the same pair twice is a no-op. No file is written.
- **`GET /runs`**: each run gains `feature: { slug, title, why: string | null, missing: boolean } | null` — `null` when the goal has no REALIZES edge; `missing: true` with `title = slug` when the edge points at a slug with no knowledge entry; `why` = first paragraph under `## Why this exists`, else the body's first paragraph, cut at 400 characters on a word boundary with `…`.
- **Runs card**: a feature line under the goal title — name, `why`, link `#/knowledge?slug=<slug>`; "No feature" when null; "Feature not found" when missing.
- **KnowledgeView** opens the entry named by `?slug=` on load.
- **`feature_projection` ceo-po** no longer throws on a technical body: sections that contain a file path, dotted symbol or SQL token are left out of the CEO view and named in its honesty section; the guard still throws if such a token reaches the final CEO answer.
- **/choda-plan**: §4 proposal names the goal's feature (existing, or a new one drafted with `## Why this exists`); §5 creates it with `knowledge_create(type feature)` when new, then `feature_link`. **/choda-autopilot** §0: a goal with no feature is refused with one 🟡 notice "goal TASK-x has no feature — link one (/choda-plan)".
- **Backfill**: a one-time table of the goals on the Runs screen → feature (existing or new), approved by Butter, applied with `feature_link`.

### Scores
| # | Dimension | Score | Why exactly this — evidence | What it needs to reach 9 |
|---|---|---|---|---|
| 1 | Problem & value | 9 | carried | — |
| 2 | Scope & boundary | 9 | D1-D4 decided; out: several features per goal, model-written summaries, editing features from the companion | — |
| 3 | Technical contract | 9 | above; write/read APIs read (relationship interface, builder:159) | — |
| 4 | Prior art | 9 | TASK-988/992/994 feature graph; edges-only reading by the projection; autopilot dirty-tree rule rules out frontmatter writes | — |
| 5 | Edges & failure | 9 | unknown task/feature, wrong type, already linked, re-link, dangling slug, no "Why" section, long body, technical body in CEO view, old adapter without `feature` | — |
| 6 | NFR | 9 | perf: one edge read + one knowledge read per run (≤ ~15 runs); security: bridge token, MCP local; data: edges only, no repo writes; i18n: English UI, feature prose shown as written; a11y: link is a real anchor; integration: vendored adapter → web treats missing `feature` as unknown | — |
| 7 | Acceptance criteria | 9 | drafted per subtask below, each with a failing input | — |

**TOTAL = MIN = 9**. Previous 3 → 9. New evidence: YES (6).

### Score history
| # | Dimension | R1 | R2 |
|---|---|---|---|
| 1 | Problem & value | 9 | 9 |
| 2 | Scope & boundary | 6 | 9 |
| 3 | Technical contract | 6 | 9 |
| 4 | Prior art | 8 | 9 |
| 5 | Edges & failure | 6 | 9 |
| 6 | NFR | 5 | 9 |
| 7 | Acceptance criteria | 3 | 9 |
| | **MIN** | **3** | **9** |

## All dimensions ≥ 9 after 2 rounds

| # | Dimension | WHY it earned 9 |
|---|---|---|
| 3 | Contract | the tool reuses `addRelationship`/`removeRelationship`; the projection already reads edges (builder:159); `/runs` extends the TASK-2531 payload additively |
| 5 | Edges | each failure has a named answer (error code, "No feature", "Feature not found", 400-char cut, CEO honesty note) |
| 7 | AC | every draft AC names its test file and a discriminating input (a second feature, a dangling slug, a `jsonb` body, `?slug=` on load) |

Exemptions: none
Unproven assumptions: the backfill's feature choices are Butter's to approve; creating new features for old runs writes files into their workspace repos (bpa-engine, NewJuvenisMaxime…) and those repos must be committed by hand or by the run that owns them.
Rounds: 2 · evidence: 12 citations (code 7, data 1, tool 1, file 1, user 2)
