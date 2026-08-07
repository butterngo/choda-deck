---
type: gotcha
title: URL normalization defeats path-traversal tests — route on the raw req.url
projectId: choda-deck
scope: project
refs:
  - path: src/adapters/companion/artifacts.ts
    commitSha: 999111045a97ba3217915d9a1766aae89c9d9816
  - path: src/adapters/companion/artifacts.test.ts
    commitSha: 999111045a97ba3217915d9a1766aae89c9d9816
createdAt: 2026-08-05
lastVerifiedAt: 2026-08-05
affectedFeatureId: feature-companion-cockpit
---

## Trigger

Writing, reviewing, or testing a path-traversal guard on any route that serves files
from disk.

## Context

`GET /artifacts/*` (TASK-1566) streams capture artifacts — screenshots, HAR bundles
carrying cookies and `Authorization` headers, DOM dumps. Its traversal guard is the
only thing between a bridge token and the rest of the filesystem, including
`database/choda-deck.db`.

The obvious implementation routes off `url.pathname`. The obvious test sends
`/artifacts/../../database/choda-deck.db` with `fetch` and asserts 403.

Both are wrong, and they fail together in a way that looks like success.

## Business rule

**Match the RAW `req.url`, not `url.pathname`. A traversal refusal must not depend on
the URL parser's normalization.**

WHATWG `new URL()` collapses dot segments — including percent-encoded ones — before any
handler sees them:

```
/artifacts/../../database/choda-deck.db          -> /database/choda-deck.db
/artifacts/%2e%2e/%2e%2e/database/choda-deck.db  -> /database/choda-deck.db
/artifacts/..%2f..%2fdatabase/x.db               -> unchanged   (encoded slash survives)
```

Route off the normalized path and the attack never reaches your route at all: it falls
through to the router's 404. The database stays safe, but by accident — the refusal came
from a fallback, not from a check. Add a guard bug later and nothing catches it.

## Resolution

1. **Route on `req.url`** (split off the query yourself). `artifacts.ts` matches the raw
   prefix, then rejects any segment that is `.`, `..`, empty, or absolute, *and*
   resolve-and-confines against the root as a second layer.
2. **Test over a raw socket.** `fetch` (undici) and `curl` both normalize the attack away
   client-side before it leaves the machine — a test through them asserts 404 and proves
   nothing about the guard. `artifacts.test.ts` opens a `net.connect` and writes the
   request line verbatim. For manual checks, `curl --path-as-is`.
3. **Assert on the payload, not just the status.** The tests check the response contains
   no `SQLite format 3` header — a broken guard's tell is a 200 whose body starts with it.

An attacker extends no courtesy about client-side normalization. Test the request they
would actually send.

## Related

- TASK-1566 — established this; `docs/reports/task-1566-ac-verification.md`
- gotcha `secret-carrying-capture-kinds-are-local-only-never-inbox-task` — why this route
  is token-gated when the sibling read routes are not
