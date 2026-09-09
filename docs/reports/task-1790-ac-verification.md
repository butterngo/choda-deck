---
task: TASK-1790
title: Folders start closed — the measurement that justified opening them is no longer true
verified: 2026-09-09
session: SESSION-1788921080763-101
note: verified retroactively — the code shipped in companion #81 and the task record never closed
---

# AC verification — TASK-1790

**Done: 5/5. Needs a human: none. Blockers: none.**

Merged in `7ee4047` (companion #81), asserted an ancestor of `origin/main`.
Nothing was implemented here.

## Criteria

Every criterion has a test that names it, and every criterion the task said
needed a control has one. Fresh run today: `DocTree.test.tsx`, 11 tests, green.

| AC | Verdict | Test | Control |
|---|---|---|---|
| AC-1 | ✅ | "shows no folder's children" | "the top-level rows themselves ARE there" — collapsed is not an empty tree |
| AC-2 | ✅ | "reports aria-expanded=false on every folder, **and flips it**" | both halves in one test, so a static attribute cannot pass |
| AC-3 | ✅ | "opens the ancestors of the selection" | "an unrelated branch stays shut" — stops an implementation that opens everything |
| AC-4 | ✅ | "keeps a folder's state when a file in a DIFFERENT folder is selected" | neighbours: opening one folder opens only that one; a parent does not open its children |
| AC-5 | ✅ | "still shows how many files a closed folder is hiding" | — |

## What the code says about itself

`DocTree.tsx:14-27` carries the whole argument rather than just the outcome: the
measurement that changed (companion 26 → 425, remote-workflow 61 → 1,784, ABC
4,176), the sentence *"The decision did not change its mind — the fact under it
changed"*, and the state-model inversion with TASK-1780's original reasoning
quoted before it is turned around: *"store OPEN paths, and empty means shut"*.

That is why this verification was cheap. The criteria named their controls, the
tests were written to those names, and the module explains why it is the shape it
is. A reader arriving cold does not have to reconstruct any of it.

## Findings

This is the fourth of four records in the Files/audit chain that shipped in
August and stayed TODO — after TASK-1787 (#258), TASK-1788 (#78) and TASK-1789
(#80, still open at time of writing). All four were graded "ready" and ordered by
`/choda-plan` on 2026-09-08 without anyone checking whether the code existed.

Unlike its siblings, this one closes clean: 5/5, no human criterion, nothing
carried forward.
