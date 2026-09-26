---
type: learning
title: Pin what the implementation answers, not what it ought to, when the point is agreement
projectId: choda-deck
scope: project
refs:
  - path: src/adapters/companion/fence-agreement.test.ts
    commitSha: fff687f39ed211e660c9ff07bae0f72bca67aa3f
  - path: src/adapters/companion/__fixtures__/fence-agreement.md
    commitSha: fff687f39ed211e660c9ff07bae0f72bca67aa3f
createdAt: 2026-09-14
lastVerifiedAt: 2026-09-21
---

**Trigger:** you are writing a pinned expectation table that two independent copies of an algorithm must both satisfy — typically because they live in different repositories or runtimes and cannot import each other. One of the values the implementation produces looks wrong.

## Context

A shared fixture plus a pinned table is the cheapest way to make a disagreement between two copies fail a build instead of silently corrupting something. But the moment you write the table, you face a choice about any value that looks like a defect.

## Business rule

**When the purpose of a table is to prove two implementations AGREE, pin what they actually answer.** Correcting a value while writing the table does three things, all bad:

1. It reddens both sides immediately, so the table proves nothing about their agreement — only that neither matches your preference.
2. It hides a real behaviour that callers may already depend on.
3. It conflates two changes — establishing agreement, and altering behaviour — in one step, so neither can be reviewed on its own.

A quirk pinned identically on both sides still does the job it exists for: if one side later drifts, the table catches it.

## Worked example

`listMermaidFences` returns, for an empty fence in the shared fixture:

```
{ index: 4, start: 66, end: 65, code: '' }
```

A start **after** its end. It reads like an off-by-one. It is how the function expresses an empty range — `slice(start - 1, end)` yields `[]` — and both implementations do it identically.

Pinning `{ start: 66, end: 66 }` because it looks tidier would have reddened choda-deck and choda-deck-companion simultaneously, on their first run, for a difference nobody introduced.

## Resolution

- Derive the table by **running** the authority and recording the output. Do not write it from what the code appears to do.
- Say in the table's own comment that it records real behaviour, and name the value that looks wrong, so the next reader does not "fix" it.
- If the quirk genuinely is a defect, changing it is a **separate** change touching both implementations and both tables at once, with its own reason.

## The corollary that bites later

When a pinned table goes red, the failure is a signal, not a nuisance. Editing the table until it passes is the exact failure the table was built to prevent, performed by hand. Fix the implementation, or change both sides deliberately.

## Related

- The decision this came from: `docs/reports/task-1943-fence-agreement-decision.md`
- Why the duplication was kept rather than removed: option 2 there, and `TASK-1936`'s counter-example where `safeResolve` and `readRawBody` were shared precisely because a second copy drifts.
