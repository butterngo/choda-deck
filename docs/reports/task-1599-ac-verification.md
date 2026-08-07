# TASK-1599 — AC verification

**Task:** Adapter · `GET /knowledge/search` returns a body excerpt per hit
**Session:** SESSION-1786097261185-12
**PR:** [#247](https://github.com/butterngo/choda-deck/pull/247) — squash-merged as `5f39911`
**Merge proof:** `git merge-base --is-ancestor 5f39911776cc1dd4e59320606a2350afea8eca1a origin/main` → ancestor ✅
**CI:** 3/3 green — `build-and-test (ubuntu-latest)` 1m17s, `build-and-test (windows-latest)` 1m45s, `docker-image` 44s

**Result: 5/5 verified · 0 blocked · 0 needing a human.**

## Criteria

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | 200, and every item in `results` carries a string `excerpt` | ✅* | Test *"carries an excerpt on EVERY hit, not just the first"* loops all 3 results. See **Surface substitution** below |
| 2 | Frontmatter + leading `#` stripped, capped at 240 | ✅ | *"strips frontmatter and the leading heading"* asserts `startsWith('---')===false`, `startsWith('#')===false`, contains the prose, excludes the title. Cap by *"caps the excerpt at 240 characters"* |
| 3 | Empty body → `""`, never null/omitted | ✅ | *"returns '' rather than null or undefined"* (strict `toBe('')`) plus *"still returns the hit when the entry file is missing"* |
| 4 | Existing response fields unchanged — additive only | ✅ | `KnowledgeSearchHit extends KnowledgeListItem` untouched; `git show 0aeddde -- knowledge-types.ts` adds only `excerpt`. Pre-existing slug/distance/providerId tests pass unmodified |
| 5 | `enabled: false` responses unaffected, still carry `reason` | ✅ | Both disabled branches return before `excerptOf` is reached. Pre-existing service tests and route test `knowledge.test.ts:118-122` pass unmodified |

## Surface substitution (AC-1)

AC-1 named `curl GET /knowledge/search`. It was verified **at the service
layer** — `KnowledgeService.searchKnowledge` against real sqlite-vec with a
fake embedding provider — plus the code-path fact that the route is a
pass-through:

```ts
sendJson(res, 200, await svc.searchKnowledge(query, topK))
```

The existing route test stubs the service to `enabled: false`, so **no test
observes a populated result set over HTTP**. That is a real gap: it would miss
a serialization regression introduced by a future response mapper or DTO
layer. Recorded openly and filed as **TASK-1604** rather than left implicit in
an evidence string.

## The test-suite scare, and why it was not waved through

One mid-task full run reported `132 passed (133)` with
`Worker exited unexpectedly` — superficially the documented worker-fork flake.
**TASK-1566 established that this exact signature can be a real defect
masquerading as the known flake**, so it was measured rather than assumed:

| Run | Code | Result |
|---|---|---|
| A | with changes | 132/133 files, 1612 tests, worker error |
| B | **clean `main`** (changes stashed) | 133/133, 1614 tests, no error |
| C | with changes restored | 133/133, **1619** tests, no error |
| D | with changes (confirm) | 133/133, **1619** tests, no error |

Runs A and C/D are *identical code with different outcomes*, which proves the
error is non-deterministic and independent of this change. 1619 = 1614
baseline + 5 new tests, so nothing was silently lost. Had B shown the error
too, it would have been the known flake; had C reproduced A, it would have
been my defect. Neither shortcut was taken.

## Concurrency observed

Between this iteration's git-state check and its first stash, another session
committed and pushed `1c1359b docs(knowledge): auto-start path ownership…` to
`origin/main` — visible at `HEAD@{1}` in the reflog. The pre-existing dirty
`docs/knowledge/` files flagged at iteration start were that session's work.

Impact on this task: none. The branch is based exactly on `origin/main`, and
`git log origin/main..main` was empty before pushing, so PR #247 carries only
its three files. Noted because a shared checkout with concurrent writers is
the condition under which a blind `git add -A` would have shipped someone
else's work — staging was explicit, per burn-down §7.

## Gates

| Gate | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm test` | 1619 passed, 133/133 files (see table above) |
| `npm run lint` | pass |
| `npm run build` | `cli.cjs` 1.8mb, `companion-server.cjs` 479.9kb |

## Findings

**The design note's premise for this task was wrong, and the code said so.**
It assumed FTS5 `snippet()` with matched-term highlighting. Search is
semantic — sqlite-vec + embeddings ranked by vector distance — so a hit may
share no literal term with the query and there is no span to highlight. The
task was rescoped during planning to a leading body excerpt, and
`KnowledgeSearchHit.excerpt` carries a comment saying it is not a snippet,
because wrapping it in `<mark>` is the obvious next move for a UI author.
TASK-1602 carries a matching AC forbidding `<mark>` in the result list.

## Follow-ups

- **TASK-1604** (created) — route-level assertion that `excerpt` survives HTTP
  serialization on a populated result.
