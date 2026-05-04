---
type: decision
title: "ADR-022: Workspace-scoped knowledge — multi-repo project support"
projectId: choda-deck
scope: project
refs:
  - path: src/core/domain/repositories/schema.ts
    commitSha: ac722fc7eea19f93a7ba321df91e64415d6e6263
  - path: src/core/domain/repositories/knowledge-repository.ts
    commitSha: ac722fc7eea19f93a7ba321df91e64415d6e6263
  - path: src/core/domain/knowledge-service.ts
    commitSha: ac722fc7eea19f93a7ba321df91e64415d6e6263
  - path: src/core/domain/knowledge-types.ts
    commitSha: ac722fc7eea19f93a7ba321df91e64415d6e6263
  - path: src/core/domain/knowledge-frontmatter.ts
    commitSha: ac722fc7eea19f93a7ba321df91e64415d6e6263
  - path: src/adapters/mcp/mcp-tools/knowledge-tools.ts
    commitSha: ac722fc7eea19f93a7ba321df91e64415d6e6263
  - path: src/core/domain/interfaces/knowledge-operations.interface.ts
    commitSha: ac722fc7eea19f93a7ba321df91e64415d6e6263
createdAt: 2026-05-04
lastVerifiedAt: 2026-05-04
---

# ADR-022: Workspace-scoped knowledge — multi-repo project support

> AI-Context: ADR-018 assumed `1 project = 1 cwd = 1 docs/knowledge/`. That breaks for multi-repo projects (e.g. `automation-rule` whose `cwd` is the vault, with separate workspaces `workflow-engine` and `remote-workflow` pointing at distinct repos). This ADR adds an optional `workspace_id` dimension to the knowledge layer: when present, the entry is filed under the workspace's repo (`<workspaceCwd>/docs/knowledge/<slug>.md`) and indexed with `workspace_id` set; when absent, behavior is identical to ADR-018 (project-level entry). Backwards-compatible — existing rows have `workspace_id = NULL`.

## Status

Accepted — 2026-05-04. Supersedes ADR-018 §4 (storage layout for multi-repo projects only); ADR-018 §1–§3 + §5 unchanged.

## Context

ADR-018 established the knowledge layer with one storage rule: project-scope notes live in `<projectCwd>/docs/knowledge/<slug>.md`. This works for single-repo projects (choda-deck has 22 entries under `<choda-deck>/docs/knowledge/`).

It does **not** work for multi-repo projects:

- `automation-rule.cwd = C:\Users\hngo1_mantu\vault` — the vault, not a repo. Writing `docs/knowledge/` to the vault is wrong; it puts ADRs about Java/TS code into a markdown notebook, away from the code itself.
- Workspace `workflow-engine.cwd = C:\dev\test\workflow-engine` (BE repo) — already has 20 ADRs in `docs/knowledge/` from a prior project, never indexed by choda-deck.
- Workspace `remote-workflow.cwd = C:\dev\test\remote-workflow` (FE repo) — separate codebase with its own future ADRs.

Two concrete blockers under ADR-018:

1. `knowledge_create({ projectId: 'automation-rule', ... })` writes to `<vault>/docs/knowledge/` — wrong location, breaks the "ADR lives next to code" invariant.
2. The 20 existing workflow-engine ADRs cannot be ingested via `knowledge_create` without writing duplicate files to the wrong directory; there is no "register an existing file" path.

The schema reflects the same gap: `knowledge_index` has `project_id` only. The workspace dimension — already first-class in `sessions`, `workspaces`, conversation `target_role` (ADR-021) — is invisible to the knowledge layer.

## Options considered

| Option | Description | Pro | Con |
|---|---|---|---|
| A. Promote each workspace to its own project | Treat `workflow-engine` as `projectId=workflow-engine`, drop `automation-rule` as a parent | Reuses ADR-018 unchanged | Loses the "one task list, one inbox, one set of conversations across both repos" property that motivated grouping them under one project; ripples through every domain (tasks, inbox, sessions) |
| B. Per-project storage override | Add `projects.knowledge_root` column; `automation-rule` points at one specific repo | Minimal schema change | Single root cannot serve a project with N repos — falls over the moment a second repo wants its own ADRs |
| C. Optional `workspace_id` on knowledge entries | `knowledge_index.workspace_id` nullable; presence ⇒ workspace-scoped, file under `<workspaceCwd>`; absence ⇒ project-scoped, file under `<projectCwd>` (unchanged) | Backwards-compatible (NULL preserves ADR-018 behavior); files stay next to the code they describe; aligns with Phase 3 routing convention `projectId/workspaceId` (ADR-021) | Two storage paths to test (project-level vs workspace-level); the 20 existing files require an "ingest existing" tool since `knowledge_create` would refuse to overwrite |
| D. Force every multi-repo project to use cross-scope (vault) | Treat all multi-repo knowledge as `scope=cross` | No schema change | Loses staleness tracking — the whole point of ADR-018 |

## Decision

**Chosen: Option C — Optional `workspace_id` on knowledge entries.**

### 1. Schema migration (idempotent, additive)

```sql
ALTER TABLE knowledge_index ADD COLUMN workspace_id TEXT NULL REFERENCES workspaces(id);
CREATE INDEX IF NOT EXISTS idx_knowledge_workspace ON knowledge_index(workspace_id);
```

Existing rows keep `workspace_id = NULL` (project-level). The migration sits inside `runLegacyMigrations()` in `src/core/domain/repositories/schema.ts`, wrapped in `try { ... } catch { /* exists */ }` per the established pattern. Re-running on a migrated DB is a no-op.

### 2. Storage routing

| `workspaceId` argument to `knowledge_create` | File path                                          | DB `workspace_id` |
|----------------------------------------------|----------------------------------------------------|-------------------|
| omitted                                      | `<projectCwd>/docs/knowledge/<slug>.md` (ADR-018)  | `NULL`            |
| present, validated                           | `<workspaceCwd>/docs/knowledge/<slug>.md`          | `<workspaceId>`   |

Validation: `workspaceId` must belong to `projectId`. Cross-project workspace IDs raise `KnowledgeValidationError` before any file is written.

### 3. Frontmatter spec

Optional `workspaceId` field; auto-written when workspace-scoped, omitted otherwise. Existing files are untouched.

```yaml
---
type: decision
title: ...
projectId: automation-rule
workspaceId: workflow-engine        # NEW — optional
scope: project
refs: [...]
createdAt: 2026-04-15
lastVerifiedAt: 2026-05-04
---
```

The frontmatter parser accepts the new key; serializer writes it only when present. Notes without `workspaceId` parse exactly as before.

### 4. New tool — `knowledge_register_existing`

Required for backfill of pre-existing ADRs (the 20 workflow-engine files). Signature:

```ts
register_existing({ filePath, projectId, workspaceId? })
```

Behavior:
1. Read the file. Parse frontmatter (must already include `type`, `title`, `projectId`, `scope`, `createdAt`, `lastVerifiedAt`).
2. Validate `projectId` argument matches frontmatter (or override frontmatter — see Backfill).
3. INSERT into `knowledge_index` (or upsert on slug match — idempotent on re-run).
4. Trigger embedding pass.

It does **not** create or modify the file — that responsibility belongs to the caller (in practice, the backfill script edits the file's frontmatter to fix `projectId` + add `workspaceId`, then calls this tool).

### 5. INDEX.md scope

`INDEX.md` regeneration runs per **project** under ADR-018 (one INDEX.md at `<projectCwd>/docs/knowledge/INDEX.md`). Workspace-scoped entries are *not* mixed into the project INDEX.md when the project's cwd is a different filesystem location (e.g. vault) — they get their own per-workspace INDEX.md at `<workspaceCwd>/docs/knowledge/INDEX.md` listing only that workspace's entries.

Rule: an INDEX.md lists every entry whose file lives in the same `docs/knowledge/` directory as the INDEX.md itself. This keeps each repo's index self-contained and avoids cross-filesystem references.

### 6. Backfill plan — workflow-engine ADRs

A one-shot script `scripts/ingest-automation-rule-workflow-engine.mjs`:

1. Glob `C:\dev\test\workflow-engine\docs\knowledge\ADR-*.md`.
2. For each file: parse frontmatter, rewrite `projectId: workflow-engine` → `projectId: automation-rule`, add `workspaceId: workflow-engine`, write back.
3. Call `knowledge_register_existing({ filePath, projectId: 'automation-rule', workspaceId: 'workflow-engine' })`.
4. Trigger embedding pass.

Frontmatter changes are committed in the workflow-engine repo (separate commit, separate repo).

## Why not others

| Option | Rejected because |
|---|---|
| A. Workspace = project | Discards the multi-repo grouping primitive that the project model already provides. Forces every cross-workspace concern (shared task list, shared inbox, shared session history) to be re-implemented at the project layer |
| B. Per-project knowledge_root | One root per project cannot describe N repos. The first project that adds a third repo breaks |
| D. Force cross-scope | `scope=cross` exists for vendor-agnostic concepts; using it for code-coupled ADRs strips staleness tracking — directly negates ADR-018's central guarantee |

## Consequences

- **Good:** Multi-repo projects work. Files live next to code (staleness still computable). Backwards-compatible — existing 22 choda-deck rows untouched (`workspace_id = NULL`). Migration is idempotent ALTER TABLE — replays cleanly. Aligns with the `projectId/workspaceId` address convention already used by sessions and ADR-021 event routing.
- **Bad:** Two storage paths in `resolveFilePath()` — `workspaceId` present vs absent. Every code path that touches a knowledge entry must consider workspace context (lookup `workspaces` row when `workspace_id IS NOT NULL`). `INDEX.md` is now per-`docs/knowledge/`-directory rather than per-project, which a future contributor needs to understand.
- **Risks:**
  - **Workspace deletion:** if a workspace is deleted, its knowledge rows orphan (FK enforcement is advisory in SQLite without `PRAGMA foreign_keys=ON`). Mitigation: `workspace_remove` should refuse when `knowledge_index.workspace_id = ?` rows exist, or cascade-delete with explicit confirmation. Out of scope for this ADR — existing `WorkspaceRepository.countReferences()` already returns session counts; extend to include knowledge in a follow-up.
  - **Slug collisions across workspaces:** `knowledge_index.slug` is PRIMARY KEY (project-global, not project-scoped). Two workspaces under the same project both creating `adr-001` collide. Mitigation: callers must namespace slugs (e.g. `workflow-engine-adr-001`) or rename. Acceptable — the 20 existing ADRs already use globally unique numbering within their repo, and choda-deck's slugs are ADR-NNN-keyword which won't collide.
  - **Embedding store keys by slug:** unchanged. Workspace-scoped entries embed exactly like project-scoped ones; semantic search returns hits regardless of `workspace_id`. Filtering by workspace happens in `listKnowledge` only, not in `searchKnowledge` (cross-workspace surface area is the *point* of semantic search).

## Impact

- **Files / modules changed:**
  - `src/core/domain/repositories/schema.ts` — ALTER TABLE + index inside `runLegacyMigrations` / `createIndexes`.
  - `src/core/domain/knowledge-types.ts` — add optional `workspaceId` to `KnowledgeFrontmatter`, `KnowledgeIndexRow`, `KnowledgeListItem`, `CreateKnowledgeInput`, `KnowledgeListFilter`.
  - `src/core/domain/knowledge-frontmatter.ts` — parse + serialize `workspaceId`.
  - `src/core/domain/knowledge-service.ts` — accept `workspaceId` in `createKnowledge`, route file path via workspace lookup, validate ownership; add `registerExisting`; respect filter in `listKnowledge`; per-directory `INDEX.md` regeneration.
  - `src/core/domain/repositories/knowledge-repository.ts` — read/write `workspace_id`; filter by workspace in `list`.
  - `src/core/domain/interfaces/knowledge-operations.interface.ts` — add `registerExisting`.
  - `src/adapters/mcp/mcp-tools/knowledge-tools.ts` — add `workspaceId` arg to `knowledge_create` / `knowledge_list`; add `knowledge_register_existing` tool.
  - `scripts/ingest-automation-rule-workflow-engine.mjs` — backfill script (one-shot).
- **Dependencies affected:** none (no new packages).
- **Migration needed:** SQL ALTER TABLE (additive, idempotent). No data backfill required for choda-deck rows. Vault decision files in workflow-engine repo updated by the backfill script.

## Revisit when

- A workspace genuinely needs entries from a sibling workspace's knowledge in its INDEX.md — i.e. cross-workspace project view becomes a real ask. Today that need is served by `knowledge_search` (semantic) and `knowledge_list({ projectId })` (lists across all workspaces of a project).
- Slug collisions become frequent — at that point migrate `knowledge_index.slug` from PRIMARY KEY to a composite key on `(project_id, workspace_id, slug)` and index by it. Not done preemptively because every consumer currently treats slug as a global handle.
- A workspace is deleted with knowledge rows attached — formalize the cascade or refusal policy in a follow-up ADR.

## Related

- ADR-018: Knowledge Layer Foundation — superseded for multi-repo projects only; storage rule (§4) extended, scope split (§2) unchanged.
- ADR-021: Cross-project event routing — established the `projectId/workspaceId` address convention that this ADR's `workspace_id` column makes structural.
- TASK-651: implementation task tracking this ADR's work (schema, tooling, backfill).
- TASK-643: sqlite-vec semantic search — verifies cross-project + cross-workspace search still functions after migration.
