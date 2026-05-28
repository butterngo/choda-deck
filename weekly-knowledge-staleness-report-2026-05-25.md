# Weekly Knowledge Staleness Check — Choda Deck

**Run date:** 2026-05-25 (automated weekly + interactive backfill)

## Headline

The choda-deck knowledge index started this run empty (as reported by `knowledge_list`), but a direct SQLite query against `data/database/choda-deck.db` revealed 71 rows total, 43 of them tagged `project_id='choda-deck'`. The `knowledge_list` MCP wrapper appears to be collapsing its response payload to `{}` in this client — data is healthy, surfacing is the issue.

The interactive backfill is also complete: 37 files from `C:\dev\choda-deck\docs\knowledge\` were registered via `knowledge_register_existing`.

## Backfill results

| Outcome | Count | Notes |
|---|---|---|
| Registered this run | 37 | All ADRs + specs with valid frontmatter under `docs\knowledge\` |
| Skipped — incomplete frontmatter | 2 | See "Files needing attention" below |
| Already present before run (choda-deck tag, but file paths elsewhere) | 6 | See "Likely mistagged entries" below |
| **Total choda-deck rows in index now** | **43** | scope: 42 project / 1 cross |

## Files needing attention

Both files have valid YAML frontmatter blocks but are missing required fields. They need frontmatter additions before `knowledge_register_existing` will accept them:

- `docs\knowledge\auto-safe-validator-audit-2026-05-11.md` — missing `projectId`, `scope`, `createdAt`, `lastVerifiedAt`
- `docs\knowledge\spike-prewarm-budget-2026-05-11.md` — missing `type`, `projectId`, `scope`, `createdAt`, `lastVerifiedAt`

## Likely mistagged entries (pre-existing)

These 6 rows already had `project_id='choda-deck'` in the index, but their `file_path` points outside this repo:

| Slug | Pinned file path | Likely belongs to |
|---|---|---|
| ADR-001-architecture-overview | `C:\dev\choda-gateway\docs\knowledge\…` | choda-gateway |
| ADR-002-tag-profile-tool-exposure | `C:\dev\choda-gateway\docs\knowledge\…` | choda-gateway |
| ADR-003-manifest-reload-contract | `C:\dev\choda-gateway\docs\knowledge\…` | choda-gateway |
| ADR-004-per-upstream-execution-policy | `C:\dev\choda-gateway\docs\knowledge\…` | choda-gateway |
| ADR-005-tool-naming-as-public-contract | `C:\dev\choda-gateway\docs\knowledge\…` | choda-gateway |
| toy-harness-cm-resume-for-ad-hoc-plan-generate-evaluate-research | `C:\Users\hngo1_mantu\vault\30-Knowledge\…` | vault / cross-scope |

Recommend: either re-register them with their correct project (`choda-gateway`), or fix their frontmatter `projectId` and re-run register. Five of these also fill the ADR-001/002/003/004/005 slots for choda-deck, masking the real numbering gaps in this repo.

## ADR numbering issues in choda-deck repo

Independent of the index, the file system in `docs\knowledge\` shows numbering collisions and gaps:

- **Duplicates:** ADR-019 (`adr-numbering-convention.md` + `autonomous-queue-runner.md`), ADR-023 (`agent-memory-layer.md` + `auto-safe-v2-hardening.md`)
- **Missing in sequence:** ADR-001, ADR-003 (no choda-deck-owned files at these numbers)
- **Inconsistent casing:** `adr-027-…` is lowercase; everything else uses `ADR-NNN`

ADR-019 (numbering convention) is itself one of the duplicates — worth resolving first.

## Cross-project index totals (informational)

| Project | Rows |
|---|---|
| choda-deck | 43 |
| automation-rule | 21 |
| micro-k8s | 3 |
| pim | 3 |
| mantu | 1 |

## Constraints honored

- No `knowledge_verify` calls made — the registration just populates the index; staleness verification happens next week against the now-pinned SHAs.
- No `knowledge_update` or `knowledge_delete` calls.
- File contents not modified — registration uses existing frontmatter as-is.

## Next week

With the index populated, next week's automated run will produce real staleness signal. Expect entries pointing at files like `src/core/executor/coder.ts` and `src/adapters/mcp/mcp-tools/knowledge-tools.ts` to flag drift as commits land.
