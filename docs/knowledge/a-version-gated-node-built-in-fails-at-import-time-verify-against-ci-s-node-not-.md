---
type: learning
title: A version-gated Node built-in fails at import time — verify against CI's Node, not the one you're running
projectId: choda-deck
scope: project
refs:
  - path: scripts/lib/test-files.mjs
    commitSha: 348e7888c50572272875a28f28d694d8c7a03642
  - path: scripts/test.mjs
    commitSha: 348e7888c50572272875a28f28d694d8c7a03642
  - path: .github/workflows/ci.yml
    commitSha: 348e7888c50572272875a28f28d694d8c7a03642
createdAt: 2026-07-30
lastVerifiedAt: 2026-07-30
---

## Trigger

A script works perfectly on your machine, then every CI job dies in under 30 seconds with zero
test output — the failure is a `SyntaxError` about a named export, not a test failure.

```
import { globSync, ... } from 'fs'
         ^^^^^^^^
SyntaxError: The requested module 'fs' does not provide an export named 'globSync'
```

## Context

TASK-1514 used `fs.globSync` in `scripts/test.mjs`. It landed in Node **22**; CI runs Node
**20.20.2**; this machine defaults to Node **24.15.0** via fnm. Local runs were flawless and
both CI runners failed instantly.

The damage is out of proportion to the mistake because a missing *named export from an ESM
module* is resolved at **import time**, before a single line executes. The script had careful
error handling and a fallback path — none of it ran. There is no partial success, no useful
log, and the failure looks nothing like the change that caused it.

This is worse in a test harness specifically: the file that fails to import is the one that
runs the tests, so CI reports "test failed" while no test was ever attempted.

## Business rule

**When touching Node built-ins in anything CI executes, check the API's minimum Node version
against the version CI actually uses — a newer local runtime hides the incompatibility
completely.**

fnm has several versions installed, so reproducing CI's runtime costs one command:

```bash
fnm list                                    # what's available
fnm exec --using=20 node scripts/test.mjs run scripts/lib
```

Rules of thumb:

1. Prefer an API available in the **oldest** runtime in play (here: Node 20). A hand-written
   20-line directory walker beats a built-in that splits your environments.
2. Anything gated on a recent Node version — `fs.globSync` (22), `node:sqlite` (22),
   `import.meta.dirname` (20.11) — deserves an explicit check before it ships.
3. A *runtime* API on an unused branch fails late and locally-detectably; a missing *import*
   fails immediately and everywhere. Import-time is the dangerous class.

## Resolution

Replaced `fs.globSync` with a small directory walker plus a glob→RegExp translation, both pure
and unit-tested, then verified under Node 20.20.2 locally before pushing again. See
`findTestFiles` / `patternToRegExp` in `scripts/lib/test-files.mjs`.

If a newer built-in is genuinely worth it, the alternative is raising CI's Node version
deliberately — but that is a repo-wide decision, not a side effect of one script's import line.

## Related

- Node's own docs mark version-added per API; the "Added in:" line is the thing to read.
- Same family as the caution that a green local run is not a green CI run — here the divergence
  is the runtime itself rather than timing or contention.
