---
type: gotcha
title: A new adapter route is invisible to the shipped companion — and the only signal is the 404 body
projectId: choda-deck
scope: project
refs:
  - path: src/adapters/companion/http-server.ts
    commitSha: f8dad2a57f08e23a4a33b7413432f75ece6d00bc
  - path: src/adapters/companion/workspace-symbols.ts
    commitSha: f8dad2a57f08e23a4a33b7413432f75ece6d00bc
createdAt: 2026-09-03
lastVerifiedAt: 2026-09-03
affectedFeatureId: feature-companion-cockpit
---

**Trigger:** you add a route to the companion adapter and wire the web client to call it. It
works in dev. The released app calls the same URL and gets a 404 — because the app carries its
own **vendored** copy of the adapter, which only refreshes at release (INBOX-1888).

## Context

`electron/vendor/companion-server.ts` is a build artifact (gitignored), copied from the sibling
`choda-deck` checkout's `dist/` by `scripts/vendor-adapter.mjs` during `pnpm run dist`. So a
released companion runs whatever adapter existed when its installer was built, while its web
bundle is whatever shipped in the same installer. The two halves can disagree by a whole feature.

Measured on 2026-09-02, before the 0.9.2 release:

| bundle | occurrences of `workspace-symbols` |
|---|---|
| vendored in the running 0.9.0 app | 0 |
| freshly vendored | 2 |

`/healthz` returns `{ ok: true }` and nothing else (`http-server.ts:168`) — there is **no
capability list to ask**. So the only way to tell "this adapter is too old" from "you asked for
something that does not exist" is the 404 body:

| body | meaning |
|---|---|
| `{ error: "not found" }` | the router's default — this adapter has never heard of the route |
| `{ error: "unknown workspace: X" }` | the route exists; the workspace does not |

## Business rule

Any route added to the adapter must give its own 404s a **distinguishable body**, and the client
must diagnose the router default as "your app is behind" rather than reporting it as a normal
empty answer. Telling a reader "nothing found" when nothing was searched blames the code for the
client's age.

## Resolution

`workspace-symbols.ts` names the workspace in its 404, and the web client raises
`AdapterRouteMissingError` vs `UnknownWorkspaceError` from the body (`packages/web/src/api.ts`),
rendering two different states. An unparseable 404 body falls back to the outdated-adapter
reading rather than throwing.

**This rests on a string comparison and that is the fragile part.** Reword the router's `not
found` message — a change nobody would call breaking — and the diagnosis silently inverts, with
no adapter-side test failing. INBOX-1897 proposes a `capabilities[]` field on `/healthz` to
remove the guess; the open question there is whether that list should be derived from the
router's own route table rather than hand-maintained beside it, since a hand-kept list is
forgettable in exactly the same way.
