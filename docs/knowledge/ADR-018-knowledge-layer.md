---
type: decision
title: Knowledge Layer Foundation — code-coupled MD with frontmatter and staleness tracking
projectId: choda-deck
scope: project
refs:
  - path: src/adapters/mcp/mcp-tools/knowledge-tools.ts
    commitSha: 2123dab54bb2651712c1067ccbbef08b03111963
  - path: src/core/domain/interfaces/knowledge-operations.interface.ts
    commitSha: 2123dab54bb2651712c1067ccbbef08b03111963
  - path: src/core/domain/knowledge-frontmatter.ts
    commitSha: 2123dab54bb2651712c1067ccbbef08b03111963
  - path: src/core/domain/knowledge-git.ts
    commitSha: 2123dab54bb2651712c1067ccbbef08b03111963
  - path: src/core/domain/knowledge-service.ts
    commitSha: 2123dab54bb2651712c1067ccbbef08b03111963
  - path: src/core/domain/knowledge-types.ts
    commitSha: 2123dab54bb2651712c1067ccbbef08b03111963
  - path: src/core/domain/repositories/knowledge-repository.ts
    commitSha: 2123dab54bb2651712c1067ccbbef08b03111963
createdAt: 2026-04-29
lastVerifiedAt: 2026-04-29
---

# ADR-018 — Knowledge Layer Foundation

## Status

Accepted — 2026-04-29

## Context

Knowledge artifacts in choda-deck (ADRs, spike findings, postmortems, learnings, evaluations) currently live in three disconnected places:

- `vault/10-Projects/choda-deck/docs/decisions/ADR-*.md` — decisions, no staleness tracking
- `vault/10-Projects/choda-deck/spikes/*.md` — spikes, vault repo separate from code repo so git history does not link
- Project-specific entries inside `MEMORY.md` — wrong layer; memory is for cross-conversation user/feedback context, not project knowledge

The pain: **a knowledge note has no signal whether it is still correct after the underlying code changes.** Code in `src/` evolves continuously; an ADR written against `src/services/foo.ts` at SHA `abc123` may describe behavior that no longer exists six commits later, and a reader has no way to know without re-reading the code.

A second pain: vault and code repo have independent git histories, so a note in vault referring to a file in the code repo cannot be diffed against that file's evolution.

## Decision

### 1. Code-coupled knowledge lives inside the code repo

Project-scope knowledge moves from vault to `<projectRepo>/docs/knowledge/<slug>.md`. The note and the code it describes share one git history, so staleness is computable from `git log`.

Cross-cutting concept knowledge (not tied to a specific repo's code) stays in `vault/30-Knowledge/<slug>.md` flat.

### 2. Scope split

| Scope     | Location                                       | Staleness tracked? |
| --------- | ---------------------------------------------- | ------------------ |
| `project` | `<projectRepo>/docs/knowledge/<slug>.md`       | Yes                |
| `cross`   | `vault/30-Knowledge/<slug>.md`                 | No                 |

`cross` notes describe abstract concepts (patterns, principles, vendor-agnostic learnings) that do not bind to any single repo's code; tracking staleness against code SHAs would be meaningless.

### 3. Frontmatter schema

```yaml
---
type: spike | decision | postmortem | learning | evaluation
title: <human title>
projectId: <project id>            # e.g. choda-deck
scope: project | cross
refs:
  - path: src/services/foo.ts      # repo-relative path
    commitSha: abc123              # SHA captured at write time
createdAt: 2026-04-29              # ISO date
lastVerifiedAt: 2026-04-29         # ISO date, updated by `verify`
---
```

The `type` field is a strict enum of five values. Free-text would drift; five buckets cover the observed knowledge categories without overlap.

`refs[]` may be empty for notes that are not code-coupled (e.g. an ADR about process or convention). When empty, staleness banner is suppressed.

### 4. Storage layout

| Layer              | Where                                                                 | Responsibility                          |
| ------------------ | --------------------------------------------------------------------- | --------------------------------------- |
| Body + frontmatter | MD file in project repo (project) or vault (cross)                    | Source of truth, git-tracked            |
| Index              | SQL table `knowledge_index` in `choda-deck.db`                        | Discover layer for MCP `list` queries   |
| Staleness          | Computed on-read via `git log <ref.path> <ref.commitSha>..HEAD`       | Always fresh, never cached              |

The index stores discovery metadata only (slug, projectId, scope, type, title, filePath, createdAt, lastVerifiedAt). Body lives in the file system; reading the file is required to render the full note. This avoids dual-write inconsistency between DB and disk.

### 5. INDEX.md auto-generation

`<projectRepo>/docs/knowledge/INDEX.md` is regenerated on every `create` / `update`. Format: list of entries with title, type, 1-line description from body, and a staleness flag (`✱` if any ref has commits since `commitSha`). This gives humans a navigable entry point without depending on the SQL index.

## Alternatives considered

- **Keep everything in vault.** Rejected: vault and code repo have separate git histories, breaking staleness computation against code SHAs.
- **Type-partitioned directories** (`vault/30-Knowledge/decision/`, `learning/`, etc.). Rejected: type already in frontmatter; partitioning duplicates semantic and makes type-rename a file-move operation.
- **Embed knowledge body in SQL.** Rejected: dual-write between DB and disk creates consistency burden; markdown files in the repo remain readable by any tool (GitHub, IDE, search) without needing the MCP server.
- **Cache staleness counts in DB.** Rejected: cache invalidation on every commit is more complex than a single `git log` call per `get`. Computation is cheap (milliseconds for typical repos).

## Consequences

### Positive

- Knowledge ages with code; readers get an explicit staleness signal instead of stale silence
- Single git history per project means `git blame` and `git log` work across both code and notes
- INDEX.md gives a static, tool-agnostic entry point
- Five-type enum prevents semantic drift

### Negative

- Dual location during transition: existing 17 ADRs remain in vault; new ADRs go to code repo until phase-2 migration
- Cross-project knowledge discovery requires a separate mechanism (deferred to phase 3)
- Frontmatter must be written manually until `KnowledgeService.create()` ships (this ADR is the first such manual entry — dogfood)

### Neutral

- Staleness is advisory, not enforced; a note can be marked `lastVerifiedAt` today even if `refs[]` show 50 commits behind. Verification is a human action.

## Out of scope (deferred)

- Migrating existing `vault/.../docs/decisions/ADR-*.md` to the new format with frontmatter (phase 2)
- Migrating project-specific `MEMORY.md` entries into knowledge entries (phase 2)
- `session_end` retro auto-suggesting `knowledge_create` (phase 3)
- `conversation_decide` emitting `type: decision` knowledge (phase 3)
- Cross-project / cross-repo knowledge search (phase 3)
- FTS or embedding search over knowledge bodies (phase 4 if needed)

## Related

- ADR-012 SQLite backup/restore — data layout pattern for new tables
- ADR-015 lifecycle service pattern — `KnowledgeService` follows the same transactional shape
- TASK-634 — implementation task tracking the foundation slice
- Memory `feedback_no_obsidian_mcp.md` — vault is plain MD only; choda-deck owns the knowledge layer
- Memory `feedback_confirm_pain_first.md` — staleness pain confirmed by Butter, not framework theory
