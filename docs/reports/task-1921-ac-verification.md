---
task: TASK-1921
title: A renamed file comes back under a path that does not exist, with its diff dropped
verified: 2026-09-09
session: SESSION-1788944861495-35
---

# AC verification — TASK-1921

**Done: 7/7. Needs a human: none. Blockers: none.**
Merges proven — all three are ancestors of `origin/main`:

| PR | Merge commit | What |
|---|---|---|
| choda-deck #283 | `2d3e0c9` | the adapter: `-z -M`, `oldPath`, `no-patch`, `capBytes` |
| companion #131 | `ff3ddbd` | the web: the rename affordance, the honest fallback |
| choda-deck #284 | `f2c6d0d` | the two criteria whose evidence was thinner than their wording |

## Criteria

| AC | Verdict | Evidence |
|---|---|---|
| AC-1 | ✅ | Real temp repo: `path === src/new-name.ts`, no `=>`, no `{`, `fs.existsSync` true, `oldPath` set. Live on `d07ce1b`: all three renames return on-disk paths |
| AC-2 | ✅ | Add/del counted **off the hunks** equal the stat. Live: 41/41, 18/18 · 14/14, 10/10 · 13/13, 2/2 |
| AC-3 | ✅ | Pure rename `[]`, binary `null` — **in one response**, per the criterion's wording |
| AC-4 | ✅ | Every null carries `omitted` across all three shas; the `hunks` key is present. Control: without `patch=1` the key stays absent |
| AC-5 | ✅ | `capBytes === MAX_FILE_PATCH_BYTES` on an over-cap file; control asserts a normal file has none |
| AC-6 | ✅ | "renamed from src/old-name.ts" renders, and the row opens on the **new** path |
| AC-7 | ✅ | `no-patch` → "could not be read", never "Too large"; control keeps the cap sentence and names 256 KB |

## Injections — each reddens what it should, and nothing else

| Injection | Red |
|---|---|
| swap `from`/`to` in `parseNumstat` | 5 — every rename test, no others |
| drop the `capBytes` field | 1 — the AC-5 test alone |
| binary yields `[]` instead of `null` | 3 — AC-3 and both older binary tests |
| restore the two-way omitted fallback (web) | 2 — the AC-7 pair, control included |

Recorded during the work and worth keeping: **removing `-z` alone is not a clean
injection.** It leaves a `-z` parser reading newline records and reddens unrelated
tests — it demonstrates the two halves are coupled, not which one is load-bearing.

## Two criteria that were passing on thinner evidence than they ask for

Both shipped correct behaviour in #283 and were confirmed by hand against a live
adapter. Neither had a test that would notice a regression, and the criteria say
"a test asserts". So #284 was opened rather than ticking them on a live reading:

- **AC-3** had a binary control — in a different commit, in a different
  `describe`. The criterion says *the same commit*, and it is right to: the point
  is that one response distinguishes `[]` from `null`. Moved.
- **AC-5** had no test at all for `capBytes`.

The AC-3 injection is the argument for the control's existence: with binary
returning `[]`, the pure-rename assertion still passes on its own. Only the paired
control catches a build that says "changed nothing" about everything.

## Gates

choda-deck: typecheck 0, lint 0, build 0, **2037 tests** (1 documented worker-fork
"Errors: 1").
companion: typecheck 0, lint 0, build 0, **632 web + 79 electron**.

## What this unblocks

TASK-1791 AC-5 and AC-6 both failed on exactly these defects and are now
verifiable. TASK-1792 AC-7 was ticked with a recorded caveat — that a renamed file
was described to the reader as too large — and that caveat no longer holds.

## Findings

The consumer was ready first. `FileDiff.tsx:89` has rendered `renamed from
{file.oldPath}` since the component shipped, and the field never arrived, so the
affordance had never once appeared for any commit in this repo's history. The fix
was filling a field someone had already written the reader for — a smaller job
than the defect looked when first described, and only visible because verification
read both sides rather than one.
