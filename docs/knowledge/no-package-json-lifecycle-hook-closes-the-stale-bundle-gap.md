---
type: learning
title: No package.json lifecycle hook closes the stale-bundle gap
projectId: choda-deck
scope: project
refs:
  - path: package.json
    commitSha: 306045e706dad87bc85ee857b43c2154a7f69479
createdAt: 2026-07-31
lastVerifiedAt: 2026-08-03
---

## Trigger

You reach for a package.json lifecycle hook (`prepare`, `prepublishOnly`, `postinstall`)
to make `dist/` rebuild itself, so nobody has to remember `pnpm run build:mcp` after
editing `src/`.

## Context

choda-deck ships its MCP server as a bundle at `dist/mcp-server.cjs`, and Claude Code
runs that bundle — not `src/`. Editing `src/` without rebuilding leaves the MCP server
serving old code, which is a recurring bite. TASK-1102 was filed asking for a
`prepublishOnly` hook, framed as fixing exactly this.

## Business rule

None of the npm lifecycle hooks fire on the path that matters:

- **`prepublishOnly`** runs only on `npm publish` / `npm pack`. TASK-1101 chose
  Option A — local `npx --package=file:`, no publish ever — so it can never execute.
- **`prepare`** runs on a bare local `npm/pnpm install`, on git dependencies, and
  before pack/publish. It does **not** run for `file:` deps, because npm *links* those
  rather than installing them.
- **Neither fires on a `src/` edit at all.** No hook is triggered by editing a file.

So a hook can make a *fresh clone* self-build (which is what TASK-1102 shipped, and
it is worth having — it stops `bin` entries pointing at a `dist/` that does not exist).
It cannot close the edit-then-forget-to-build gap.

Second-order hazard: seeing `"prepare": "pnpm run build"` in package.json reasonably
reads as "builds are automatic now." They are not. The manual rebuild is still
required after `src/` changes.

## Resolution

Ship `prepare` for the fresh-clone case, and treat the editing gap as a separate,
unsolved problem. The two real options — both open, neither chosen (INBOX-1646):

- a `dev:mcp` watch script that rebuilds on change, or
- making the MCP launch command build first, which pays build latency on every
  server start.

Verified 2026-07-31 with a matched negative control: a clone with the hook builds all
three bundles on `pnpm install`; an identical clone without it leaves `dist/` absent.

## Related

- TASK-1102 (shipped the hook, PR #229 → 721dc80) · TASK-1101 (Option A decision)
- INBOX-1646 — the unresolved editing-gap decision
