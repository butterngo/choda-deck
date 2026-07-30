---
type: gotcha
title: code_ref slugs are globally unique across projects, but code_ref identity is (projectId, path, symbol)
projectId: choda-deck
scope: project
refs:
  - path: src/core/domain/task-types.ts
    commitSha: 3b4684a0f8e76b145ff201c8c150c5cae4027cad
  - path: src/adapters/mcp/mcp-tools
    commitSha: 3b4684a0f8e76b145ff201c8c150c5cae4027cad
createdAt: 2026-07-30
lastVerifiedAt: 2026-07-30
affectedFeatureId: feature-knowledge-graph
---

## Trigger

`code_ref_upsert` fails on a slug collision for a path that does not exist in this project —
the name was taken by a **different** project. During TASK-1423, registering `ext-manifest`
for `choda-deck`'s `extension/manifest.json` collided with `english-companion`'s
`extension/manifest.json`, already holding that slug.

The error names the slug but not the owning project, so it reads as a bug in your own repo.

## Context

Two different notions of identity are in play:

- **Logical identity** of a code_ref is `(projectId, path, symbol)` — a path in one project is
  unrelated to the same path in another.
- **The `slug` column** is globally unique across the whole database, shared by every project
  registered in this choda-deck instance.

So short, generic, structurally-derived slugs (`ext-manifest`, `server`, `index`,
`schema`) are effectively first-come-first-served across unrelated codebases. The more
projects registered, the more the convenient names are already gone — and the collision
surfaces at write time, from a name that looks entirely reasonable locally.

## Business rule

**Assume a code_ref slug is a global name, not a project-local one.** Namespace it explicitly
when choosing one — prefix with the project or a distinguishing part of the path
(`choda-deck-ext-manifest`, `extension-manifest-json`) rather than the shortest label that
reads well inside this repo. Never assume `(projectId, path)` protects you from a name clash.

When a collision does appear, check other projects before concluding your own registration is
at fault.

## Open question

Should slugs be project-namespaced at the schema level, or should the collision error name the
owning project so the diagnosis is immediate? Raised as a loose end in TASK-1423's handoff and
still unresolved — the current behavior is a documented sharp edge, not a settled design.

## Related

- Belongs to the `code_ref` / TOUCHES layer (ADR-033 retired the graphify code-graph; the
  `code_ref` + `TOUCHES` layer via `task_touches` is what remains).
