---
type: evaluation
title: "Cross-device sync export/import — sequential dual-machine sync without duplicating project knowledge"
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-05-07
lastVerifiedAt: 2026-05-07
---

- Keep **two sync flows**: project repos carry code + `docs/knowledge/*.md`; a separate sync repo carries exported DB state only.
- Use **canonical git remote identity + local path mapping** to resolve machine-specific `workspace.cwd`.
- Treat import as a **snapshot operation** with manifest versioning, atomic apply, delete propagation, and preflight warnings.
- Do **not** promise portability for artifacts or arbitrary absolute-path prose unless they are explicitly exported/remapped.

## Status

**Responsibility:** freeze a reviewable proposal before implementation.

Proposed on 2026-05-07 from CONV-1778150663311-16. This is a spec draft, not an accepted ADR. Claude review should focus on boundary correctness and failure modes, not naming.

## Why this exists

**Responsibility:** define the smallest sync model that works for one user on two machines.

Choda-deck stores operational state in SQLite: projects, workspaces, tasks, inbox, conversations, sessions metadata, and knowledge metadata. The user wants that state available on laptop and desktop through git, but only for **sequential** use. Real-time multi-user consistency, merges, and conflict resolution are out of scope.

The main design constraint is that knowledge Markdown is already code-coupled by ADR-018. Duplicating `docs/knowledge/*.md` into a second sync repo would create two authorities for the same content.

## Recommendation

**Responsibility:** separate what is portable from what is code-coupled.

| Concern | Source of truth | Sync mechanism | Reason |
| --- | --- | --- | --- |
| Source code | Project repo | Existing git workflow | Already portable |
| `docs/knowledge/*.md` | Project repo | Existing git workflow | Must stay next to code and git history |
| DB state: tasks, inbox, conversations, sessions metadata, knowledge metadata | choda-deck export snapshot | New sync repo | Structured state needs machine-independent transport |
| Local machine path mapping | `paths.local.json` on each machine | Not synced | Absolute paths are machine-specific |
| Session artifacts under `data/artifacts/` | Local machine by default | Optional future bundle | Large, non-portable, not always needed |

Result: keep the sync repo **DB-only**. Knowledge Markdown remains outside the export because it is already carried by the project repo.

## Workspace identity across machines

**Responsibility:** replace machine-local `workspace.cwd` with a portable lookup key.

For git-backed workspaces, use a canonical repository identity:

```text
workspace_identity = canonical_git_remote + optional_repo_relative_subpath
```

Rules:

1. Canonicalize SSH/HTTPS remote forms to one normalized key before export.
2. Export the normalized key plus the source-machine `cwd` for diagnostics.
3. On import, resolve the key through a machine-local file:

```json
{
  "github.com/butterngo/choda-deck": "C:\\dev\\choda-deck"
}
```

1. If no mapping exists, prompt once during CLI import and persist the answer to `paths.local.json`.
2. For non-git folders, require an explicit stable user-defined ID or mark the workspace local-only and skip portable resolution.

### Canonicalization rule

To make `canonical_git_remote` reproducible across SSH/HTTPS forms and machines:

1. Strip credentials from the URL (`https://user:token@host/...` → `https://host/...`).
2. Normalize SSH form `git@host:owner/repo` to `host/owner/repo`.
3. Normalize HTTPS form `https://host/owner/repo` to `host/owner/repo`.
4. Lowercase the host segment (DNS is case-insensitive).
5. Strip trailing `.git` suffix and any trailing slash.
6. Preserve path case (some hosts treat paths case-sensitively).

Example: `git@github.com:ButterNgo/choda-deck.git` → `github.com/ButterNgo/choda-deck`.

This keeps machine-specific paths out of the shared snapshot while preserving deterministic resolution.

## Snapshot contract

**Responsibility:** make export/import safe, repeatable, and diagnosable.

Each export should produce a manifest plus data payload.

Suggested manifest shape:

```json
{
  "exportFormatVersion": 1,
  "appVersion": "<package version>",
  "exportedAt": "2026-05-07T10:55:00Z",
  "projectIds": ["choda-deck"],
  "workspaceIdentities": ["github.com/butterngo/choda-deck"],
  "includesArtifacts": false
}
```

Required import semantics:

1. **Preflight first**: resolve path mappings, check required project repos exist locally, detect non-canonical remote collisions, report artifact expectations.
2. **Atomic apply**: import into a temp DB or a single rollbackable transaction. Never leave a half-imported snapshot.
3. **Idempotent re-import**: importing the same snapshot twice should not create duplicate rows or drift.
4. **Delete propagation**: snapshot import must define how removed rows disappear on the target. Upsert-only is insufficient.
5. **Version gate**: if `exportFormatVersion` is unsupported, fail fast or run an explicit migrator.
6. **Pre-import auto-backup**: before applying the snapshot, create a backup of the current target DB via the existing backup-service (ADR-012), named `pre-import-<timestamp>.db`. This gives the user a one-shot undo path independent of the temp-DB rollback safety net.

## Knowledge behavior

**Responsibility:** preserve ADR-018's code-coupled model during cross-device sync.

Export only the knowledge metadata that already lives in SQLite. Do not export Markdown bodies.

On import:

1. Resolve each workspace to a local repo path.
2. Assume the user has separately cloned and pulled the project repo.
3. Mark knowledge entries `unresolved` or `stale` in preflight output when the mapped repo is missing, the file does not exist, or verification cannot run.
4. Treat this as expected environment drift, not DB corruption.

This preserves the single authority for knowledge content while still moving the structured index state across machines.

## Non-portable references

**Responsibility:** name the data that cannot be safely remapped by magic.

Three categories need explicit policy:

| Category | Problem | Proposed policy |
| --- | --- | --- |
| Structured absolute paths in DB fields | Can often be remapped | Remap only when tied to a resolved workspace identity |
| Absolute paths embedded in free-text conversation or inbox bodies | Cannot be safely rewritten | Keep as-is and warn during preflight/report |
| Session artifacts referenced from conversations | Files may not exist on the target machine | Mark as non-portable unless explicitly exported as a separate bundle |

The core rule: only rewrite data when the reference is structured and the mapping is deterministic.

## CLI flow

**Responsibility:** keep the operator model simple.

```text
Machine A
1. User works normally.
2. choda-deck export --to <sync-repo>
3. User commits + pushes sync repo.

Machine B
1. User pulls project repos via existing workflow.
2. User pulls sync repo.
3. choda-deck import --from <sync-repo>
4. CLI resolves or prompts for repo mappings once.
5. CLI runs preflight, then atomic import.
```

This keeps git ownership with the user and keeps choda-deck focused on snapshot generation and replay.

## Rejected alternative

**Responsibility:** record the tempting simplification and why it is wrong.

Rejected: make the sync repo self-contained by bundling `docs/knowledge/*.md` together with DB metadata.

Reason: this creates a second authority for code-coupled knowledge, allows drift between project repo and sync repo, and weakens the guarantee that note history tracks code history.

## Open review points

**Responsibility:** focus reviewer attention on the decisions that still matter.

1. Should import be defined as full-snapshot replace per project, or row-wise reconcile with tombstones?
2. Do we need a lightweight repo UUID file in addition to canonical remote to survive origin URL changes?
3. Should artifacts stay fully out of v1, or do conversations require an optional artifact bundle from day one?

## Known limitations (v1)

**Responsibility:** call out tables intentionally excluded from the 7 domain files so reviewers and future-us can see the seams.

- **`documents`** — code-coupled artefact pointers (ADRs, guides, specs). Project repo is already the source of truth; importing on machine 2 re-derives them once the user pulls the project repo.
- **`context_sources`** — registers the file paths that `session_start` loads as context. Excluded from v1 export so the snapshot stays bounded to the 7 declared domain files. **Side-effect:** an imported project on machine 2 has no context registered until the user (or `/context-setup`) re-registers; `session_start` will still work but with empty `contextSources`. Revisit if this becomes a friction point.
- **Cross-project relationships** — the relationship-export filter requires **both** endpoints to live in the exported item set. Cross-project edges (e.g. a task in project A that `DEPENDS_ON` a task in project B) are dropped from any single-project snapshot and reappear naturally the next time both projects sync together. This trade-off keeps each per-project snapshot self-contained — no dangling references on partial import.

## Related

**Responsibility:** connect this proposal to the existing architecture.

- ADR-018 — knowledge layer foundation.
- ADR-012 — backup/restore shows the existing data-layout precedent.
- CONV-1778150663311-16 — design review thread that triggered this draft.
