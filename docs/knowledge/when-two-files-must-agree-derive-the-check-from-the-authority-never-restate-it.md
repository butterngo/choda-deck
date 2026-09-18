---
type: learning
title: When two files must agree, derive the check from the authority — never restate it
projectId: choda-deck
scope: project
refs:
  - path: scripts/dockerfile-build-scripts.test.ts
    commitSha: 11fe8e926808a32301ca3e87e83241573fd5c740
  - path: scripts/lib/test-files.mjs
    commitSha: 11fe8e926808a32301ca3e87e83241573fd5c740
createdAt: 2026-09-16
lastVerifiedAt: 2026-09-16
---

**Trigger:** a rule has to hold across two files that cannot import each other — a
`package.json` script and the Dockerfile that must ship what it invokes, a glob list
and the runner that checks it ran, a schema and its validator, a route table and its
auth guard. You reach for the obvious guard: write the expected list into the test.

That second list is now a copy, and a copy drifts. Worse, it drifts *silently* — the
test keeps passing because it is agreeing with itself.

**The rule.** The guard reads the **authoritative** file and computes what to expect
from it. It never carries its own copy of the answer.

**Two instances in this repo, arrived at independently:**

- `scripts/lib/test-files.mjs` exports one `INCLUDE` constant that both
  `vitest.config.ts` (which globs it) and `scripts/test.mjs` (which asserts every
  matched file actually ran) import. Its own comment states the reasoning: "a
  drifting second copy of these patterns would silently re-open the hole this guard
  exists to close."
- `scripts/dockerfile-build-scripts.test.ts` (TASK-1974) parses `package.json`,
  follows the `pnpm run` chain out of `build`, extracts each `scripts/<file>` those
  commands shell out to, and asserts the Dockerfile copies them. It does not contain
  a list of build scripts. Add a build helper tomorrow and the guard covers it
  without being edited — which is the whole point, because the bug it fixes was
  exactly someone adding a script and not editing the other file.

**The failure mode this shape introduces, and how to close it.** A guard that derives
its expectations can pass **vacuously**: if the parser matches nothing, the loop body
never runs and every assertion succeeds. Green, fast, worthless — and unlike a stale
hand-written list, nothing about it looks wrong.

So a derived guard needs one more assertion, about itself:

```ts
const reached = scriptsReachedByBuild()
expect(reached.length).toBeGreaterThan(0)
expect(reached).toContain('scripts/record-bundle-size.mjs')  // a known member
```

Name a specific known entry, not just a non-zero count — a parser that matches the
wrong thing also returns a non-empty list.

**When not to do this.** If the authority is a format you would have to half-implement
a parser for, a hand-written list plus a comment saying where the authority lives is
more honest than a fragile regex that fails open. The vacuity check above is what
makes the derived version trustworthy; without it, prefer the explicit list.
