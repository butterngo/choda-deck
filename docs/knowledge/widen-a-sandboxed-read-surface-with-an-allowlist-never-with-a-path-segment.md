---
type: gotcha
title: Widen a sandboxed read surface with an allowlist, never with a path segment
projectId: choda-deck
scope: project
refs:
  - path: src/adapters/companion/vault-projects.ts
    commitSha: 
  - path: src/adapters/companion/vault-projects.test.ts
    commitSha: 
  - path: src/adapters/companion/vault.ts
    commitSha: 
createdAt: 2026-09-20
lastVerifiedAt: 2026-09-20
affectedFeatureId: feature-companion-cockpit
---

**Trigger:** a route that deliberately listed files without serving them now has to serve one. The obvious shape is `GET /…/:folder/:file` — take the filename as a path segment, join it, read it. Stop there.

## Context

`vault-projects.ts` serves `<vaultDir>/10-Projects`. Its sibling `vault.ts` serves `<vaultDir>/30-Knowledge` and its header records why the root is the *subdirectory* rather than the vault: `20-Areas` holds personal context (preferences, goals, team) which must be **structurally unreachable**, not merely unlisted.

TASK-2051 had to start returning file contents. A caller-chosen `:file` segment would mean the readable set is "whatever happens to sit in that folder" — decided by the filesystem, not by the module.

## Business rule

**The readable set is a closed list decided in the module. The caller names a member of it, never a path.**

```ts
export const MEETING_FILES = ['note.md', 'transcript.md'] as const
function isMeetingFile(name: string): name is MeetingFileName {
  return (MEETING_FILES as readonly string[]).includes(name)
}
```

Refuse a non-member on the *name*, with a 4xx that says so — not a 404. A 404 invites the caller to keep probing to learn what else is in the folder.

Segments the caller *does* choose (a project id, a meeting folder) get their own regex, an explicit dot-segment check (`.` and `..` pass most alphabets), and — after the join — a resolved-path containment check. That last one should be unreachable; it stays because a regex being exhaustive is a weaker guarantee than `path.relative` not starting with `..`.

## Resolution — and the evidence that this is not tidiness

The injection check was supposed to prove the allowlist guarded *the allowlist test*. It reddened **two** tests:

```
allowlist check replaced with `if (false)`  →  2 failed / 46 passed
  × refuses a filename outside the allowlist even though it exists
  × cannot read 20-Areas through the file route by any input here
```

The second one is the point. `ID_RE` already refuses `..` and separators, so nobody reaches `20-Areas` by traversal — but `20-Areas` is itself a **valid project id** by that alphabet, and `preferences.md` is a perfectly ordinary filename. Without the allowlist, `/vault/projects/20-Areas/meetings/x/preferences.md` is just a read. The allowlist is load-bearing for the sandbox, not decoration on top of it.

A related trap the same task hit: an earlier injection on the *listing* route reddened only the listing tests while every scoping test stayed green — because a widened root leaks **structure** (does this folder exist, what is in it) without leaking **contents**, and a marker-in-the-body assertion cannot see that. Assert the structural claim too: `20-Areas` must read as `exists: false`.

## Related

- `url-normalization-defeats-path-traversal-tests-route-on-the-raw-req-url` — the sibling guard; traversal tests must go over a raw socket because `fetch` normalises the attack away before it leaves the client.
- `a-guard-maintained-by-exclusion-list-will-be-narrowed-until-it-excludes-what-it-` — the same argument from the other direction: allowlists survive maintenance, denylists erode.
