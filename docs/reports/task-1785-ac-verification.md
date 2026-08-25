# TASK-1785 — AC verification

Session SESSION-1787660340637-29 · 2026-08-25 · merged as `17ed055` (PR #256)

**5 of 5 ticked.** Every criterion is machine-class; nothing was left for a person.

| AC | Verdict | Evidence |
|---|---|---|
| AC-1 under 1000 ms | ✅ | `TASK-985` **11,596 ms → 19 ms**; `TASK-1767` 11,660 ms → 13 ms (10–12 ms on repeat). Body recorded 14,994 ms on an idle adapter. |
| AC-2 same `adrs[]` | ✅ | `cmp` → **byte-identical**, 5318 bytes, on `TASK-985` |
| AC-3 no blocking | ✅ | 3 task reads in flight, then `/healthz`: **34,589 ms → 2 ms** |
| AC-4 staleness intact | ✅ | `/knowledge/ADR-032` still `commitsSince 2,4,1,1`, `isStale:true`, byte-identical |
| AC-5 injection | ✅ | Fix reverted → 2 tests red, confirmed applied first; restored → 5/5 |

Measurements are A/B against the **same database**: pre-fix build on port 7338, post-fix on 7401.

## The control that nearly wasn't

AC-2's first run compared `TASK-1767` and reported byte-identical. That proved nothing — `TASK-1767` has `adrs: []`, so it was **empty against empty**. A fix that lost every ADR would have passed it.

`TASK-985` was found instead: two real ADRs (`ADR-032`, `ADR-031`), both `via: "body"` — i.e. found by the prose scan, which is precisely the expensive path under test. Byte-identical there means the fast read still finds what the slow one did.

Both numbers are recorded; the weak one is labelled weak rather than dropped.

## The fix

`readKnowledgeSource(slug)` returns `frontmatter`, `body`, `filePath` and **no staleness**. The type omits the field rather than returning an empty one: `staleness: []` reads as "nothing has drifted", a claim this path has not earned. `getKnowledge` composes on top of it, so the two cannot drift on how the file is parsed.

## Findings worth carrying

1. **Widening a shared interface broke a fake at runtime while typecheck stayed green.** The `task-detail` fake is an `as unknown as` cast, so it silently returned an empty `adrs` list once the production call moved to the new method. Two tests caught it. Typecheck cannot protect an interface whose implementers are casts.
2. **A duration is the wrong thing to assert.** The test counts calls into the git port instead — "the cheap path makes zero git calls" discriminates on a loaded machine and an idle one alike, where a timing threshold would flake.
3. **The defect had been shipping since v0.7.0** (TASK-1748) and nobody filed it. A 15-second task detail reads as "the app is slow" rather than as a bug, which is how a measurable defect stays invisible.

## Gates

typecheck 0 · full suite 137 files / 1708 tests 0 (+5) · lint 0 · build 0
CI on PR #256: ubuntu, windows, docker-image — all pass.
Merge proven: `17ed055` is an ancestor of `origin/main`.
