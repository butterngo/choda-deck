---
type: learning
title: "A `prepare` hook also runs inside the Docker build — at install AND at prune"
projectId: choda-deck
scope: project
refs:
  - path: package.json
    commitSha: 999111045a97ba3217915d9a1766aae89c9d9816
  - path: Dockerfile
    commitSha: 999111045a97ba3217915d9a1766aae89c9d9816
  - path: scripts/prepare.mjs
    commitSha: 999111045a97ba3217915d9a1766aae89c9d9816
  - path: .github/workflows/ci.yml
    commitSha: 999111045a97ba3217915d9a1766aae89c9d9816
createdAt: 2026-08-05
lastVerifiedAt: 2026-08-05
---

## Trigger

You add or keep a `package.json` lifecycle hook (`prepare`, `postinstall`) in a repo
whose Dockerfile is multi-stage and installs dependencies before copying source.

## Context

`721dc80` (TASK-1102, #229) added `"prepare": "pnpm run build"` for the fresh-clone
case — see [[no-package-json-lifecycle-hook-closes-the-stale-bundle-gap]], which
reasoned through *which* hooks fire and recommended shipping it. That analysis was
about local installs and never considered the container build.

The consequence: **`main` was unbuildable as a container for 71 commits** and nobody
noticed, because the unit suite never touches the Dockerfile. It only surfaced when
micro-k8s TASK-1578 tried to roll the pod.

## Business rule

pnpm runs `prepare` on **`pnpm install`** *and* on **`pnpm prune`**. choda-deck's
Dockerfile hits both at points where a build is impossible:

- **`Dockerfile` install** — deliberately runs *before* `COPY src ./src`
  (manifests-first, for layer caching). `prepare` fires with no source present →
  `Could not resolve "src/adapters/mcp/server.ts"` → install exits 1.
- **`Dockerfile` prune** — `pnpm prune --prod` fires `prepare` *after*
  devDependencies are stripped → `sh: 1: esbuild: not found` → exits 1.

Reordering the `COPY` clears only the first. That was probe-tested: install and build
then succeed, and the prune still fails. **A lifecycle hook in a containerised repo
must be able to no-op**, not merely be sequenced correctly.

## Resolution

`scripts/prepare.mjs` guards itself — it builds when `src/` and `esbuild` are both
present, and skips with an explanatory line otherwise. Local installs are unaffected,
so TASK-1102's benefit is preserved.

Two non-obvious details:

1. **The guard is `COPY`ed with the manifests.** The first attempt failed with
   `MODULE_NOT_FOUND` — the guard has to exist in that layer in order to skip itself.
2. **`--ignore-scripts` was rejected**, though it looks like the smaller fix. It also
   suppresses `better-sqlite3` / `sqlite-vec` node-gyp builds, and the image genuinely
   needs those bindings. Verified in the built image: `vec_version()` = `v0.1.9`.

A `docker-image` CI job now builds the image and loads the native bindings. Only a
real docker build exercises the Dockerfile — that gap is precisely how this landed on
`main` green.

## Related

- [[no-package-json-lifecycle-hook-closes-the-stale-bundle-gap]] — why the hook exists
- TASK-1579 (PR #245 → `e821a34`) · TASK-1102 (PR #229 → `721dc80`)
- micro-k8s TASK-1578 — the deploy that surfaced it
