---
type: decision
title: "ADR-019: ADR Numbering Convention — keep ADR-NNN prefix in slug"
projectId: choda-deck
scope: project
refs:
  - path: .claude/skills/save-decision/SKILL.md
    commitSha: 77072221522773a567dcd770d50ad386124de47b
  - path: .claude/skills/save-decision/references/generation-steps.md
    commitSha: 77072221522773a567dcd770d50ad386124de47b
  - path: src/core/domain/knowledge-service.ts
    commitSha: 77072221522773a567dcd770d50ad386124de47b
createdAt: 2026-04-29
lastVerifiedAt: 2026-04-29
---

# ADR-019: ADR Numbering Convention — keep ADR-NNN prefix in slug

> AI-Context: New ADRs in choda-deck knowledge layer keep `ADR-NNN-<slug>` filename convention. Numbering auto-incremented via `knowledge_list type=decision` query, parsing highest N from slug regex `/^ADR-(\d+)/`. Skill passes explicit slug to preserve uppercase.

## Context

TASK-638 switched the `save-decision` skill from manual `docs/decisions/` writes to the `knowledge_create` MCP tool. The knowledge layer auto-derives slug from title, so a question surfaced: keep the legacy `ADR-NNN` numbering convention or drop it for clean descriptive slugs?

Existing state at decision time: 16 ADRs in `docs/knowledge/` (ADR-002 through ADR-018) all use `ADR-NNN-<short-slug>.md` filenames with uppercase `ADR` prefix.

## Options considered

| Option | Pro | Con |
|---|---|---|
| Keep ADR-NNN numbering | Consistent with existing 16 entries; short reference form (`ADR-019`) usable in PRs, commits, conversations | Extra `knowledge_list` round-trip per save; theoretical race on concurrent saves |
| Drop ADR-NNN, slug only | No scan round-trip; no race; simpler skill flow | Inconsistent with existing entries; loses short reference form |

## Decision

**Chosen: Keep ADR-NNN numbering.**

Scan via `knowledge_list type=decision`, parse highest N from entry slugs (regex `/^ADR-(\d+)/`), increment by 1, zero-pad to 3 digits. Skill must pass explicit `slug` argument to `knowledge_create` (e.g., `ADR-019-<short-topic>`) — service preserves explicit slug case as-is and only force-lowercases via `slugify()` when slug is omitted.

Initial design call leaned toward dropping numbering for simplicity, but reversed after observing the existing 16 entries — consistency with the established convention outweighs the negligible cost of one extra MCP round-trip.

## Why not others

| Option | Rejected because |
|---|---|
| Drop ADR-NNN, slug only | Would create a discontinuity mid-sequence (ADR-018 → `clean-slug-no-number`), breaking the `ADR-019` reference form already used in commits and PR titles. The "race condition" worry is theoretical — `/save-decision` is interactive single-user; concurrent saves don't happen in practice |

## Consequences

- **Good:** Numbering consistency preserved across all decisions; short reference form (`ADR-NNN`) retained for use in PR titles, commits, conversation
- **Bad:** One extra `knowledge_list` MCP call per save — negligible in interactive flow. Skill must be careful to pass explicit slug; if omitted, `slugify()` lowercases and produces inconsistent entries (root cause of TASK-641)
- **Risks:** If an automated agent ever starts emitting decisions concurrently, two saves could compute the same N and produce a slug collision. `knowledge_create` errors on duplicate slugs (`KnowledgeConflictError`) so a retry-with-N+1 strategy would be needed

## Impact

- **Files/modules changed:** `.claude/skills/save-decision/SKILL.md`, `.claude/skills/save-decision/references/generation-steps.md`
- **Dependencies affected:** none
- **Migration needed:** no — applies only to ADRs created after TASK-638 ships

## Revisit when

- An automated agent starts saving decisions concurrently (would need lock or retry-on-conflict in the skill, or a server-side reservation API)
- ADR count exceeds 999 (zero-pad to 3 digits no longer fits — would need to widen to 4 digits like the legacy `docs/decisions/ADR-XXXX-` form)

## Related

- ADR-018: Knowledge Layer Foundation — code-coupled MD with frontmatter and staleness tracking
- TASK-638: Switch save-decision skill từ docs/decisions/ → knowledge_create MCP
- TASK-641: Fix save-decision slug naming — pass explicit short slug + preserve ADR-NNN case
