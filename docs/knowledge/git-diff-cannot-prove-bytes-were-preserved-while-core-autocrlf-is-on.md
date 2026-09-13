---
type: learning
title: git diff cannot prove bytes were preserved while core.autocrlf is on
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-09-12
lastVerifiedAt: 2026-09-12
---

**Trigger:** you are writing, or verifying, an acceptance criterion phrased something like *"run `git diff` — only the fence's lines appear as changed"*, and you intend it as proof that a writer did not rewrite line endings or strip a BOM.

## Context

A route or editor that rewrites a file has two ways to damage it invisibly: converting CRLF to LF, and dropping a UTF-8 BOM. Both change every line of the file while changing nothing a human typed, and `git diff` is the natural-looking way to check for it.

It does not work, because git normalises line endings on both sides of the comparison before showing you anything.

## Business rule

**Under `core.autocrlf=true`, a full CRLF→LF rewrite is reported by `git diff` as no change at all.** A criterion that reads the diff therefore produces identical output whether the writer is byte-faithful or catastrophically normalising. It cannot fail, so it proves nothing.

Measured on this machine, 2026-09-12 (TASK-1931 AC-11):

```
repo config:  choda-deck, choda-deck-companion, mantu/ABCV2
              core.autocrlf=true, no .gitattributes  (all three)

experiment:   rewrite EVERY line ending CRLF->LF, plus edit one line
git reports:  1 file changed, 1 insertion(+), 1 deletion(-)

              ...which is exactly what a perfect, byte-faithful save reports.
```

## Resolution

Two options, and the second is only safe with the third step:

1. **Compare bytes, not diffs.** `sha256sum`, `Buffer.compare`, `od -An -tx1 -N3` for the BOM, `grep -c $'\r'` for the CR count. This removes git from the loop entirely and is what the criterion actually means.

2. **Or run the check in a repo built to show the truth** — `core.autocrlf=false` plus a `.gitattributes` marking the file `-text`.

3. **Either way, prove the check can fail before you trust a pass.** Apply the defect deliberately and confirm the output changes. In the TASK-1931 fixture the same fence edit produced `1 insertion(+), 1 deletion(-)` when byte-faithful and `11 insertions(+), 11 deletions(-)` when normalising — and that contrast is the only reason the eventual pass meant anything.

## Why this is filed as a learning and not a gotcha

It is not a concern about any one feature's behaviour. It is a defect in a *method of verification*, and it will bite any task in any repo whose criteria are phrased in terms of `git diff`. Anchoring it to a feature would misfile it.

## Provenance

Found while verifying TASK-1931 AC-11, which is phrased exactly this way. Had the criterion been run in ABCV2 as written, it would have passed without exercising the defect it names. Full write-up, including the two rejected test designs: `choda-deck-companion/docs/reports/TASK-1931-ac-verification.md` §7.
