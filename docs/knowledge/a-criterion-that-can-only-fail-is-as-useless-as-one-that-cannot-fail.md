---
type: learning
title: A criterion that can only FAIL is as useless as one that cannot fail
projectId: choda-deck
scope: project
refs:
  - path: src/adapters/companion/meetings.ts
    commitSha: 
createdAt: 2026-09-19
lastVerifiedAt: 2026-09-19
---

**Trigger:** you are looking at an acceptance criterion that has never passed, on a task whose work is demonstrably finished, and you are deciding whether to tick it, strike it, or leave it open.

**Context.** This project already refuses criteria that cannot fail — a check whose pass and fail produce identical output proves nothing. The mirror case is rarer and gets caught later, because it looks like diligence: a criterion nothing can satisfy.

TASK-1996 AC-1 asked that the packaged adapter bundle contain the strings `/transcribe`, `/note/draft` and `/vault/meetings`. All three were unsatisfiable, for two different reasons:

1. The router splits the path and compares **segments** (`action === 'transcribe'`, then `action === 'note' && rest[2] === 'draft'`). The literals `/transcribe` and `/note/draft` appear nowhere in the source, so nowhere in the bundle. `grep -c` returned 0 for all three against a bundle whose capability was demonstrably present and answering requests.
2. `/vault/meetings` was never built at all. TASK-1994 shipped `PUT /meetings/:id/files` after a decision reshaped that contract, five days *after* the criterion was written.

So the criterion would have failed against every build that has ever existed, including a perfect one.

**Business rule.** A criterion that no implementation can satisfy carries the same information as one that every implementation satisfies: none. Both are zero-bit tests. The failing kind is more dangerous only because it survives longer — it reads as rigour, and each person who meets it assumes the work is genuinely incomplete.

Two smells, both cheap to check:

- **It names a spelling rather than a behaviour.** Grepping for a literal asserts how the code is written, not what it does. The same capability passes or fails depending on whether someone wrote `'/a/b'` or split on `/`.
- **It predates a decision that changed the contract.** Check the criterion's write date against the decisions on its task. TASK-1996 AC-1 predated Butter's 2026-09-17 reshaping by five days and nobody re-read it.

**Resolution.** Rewrite it to test the property, not the staging, and record the rewrite in the task body — rewriting a criterion and then ticking it in the same breath is a move that deserves suspicion, so it must be visible to the next reader.

The replacement must carry its own control. AC-1 became: start the packaged adapter and confirm it *answers* all three routes, **and** that a fabricated action on the same prefix answers differently. Without that last clause every 404 looks alike and the probe proves nothing:

```
POST /meetings/x/transcribe     → 404 "meeting not found"          (route reached)
POST /meetings/x/note/draft     → 404 "meeting not found"          (route reached)
PUT  /meetings/x/files          → 400 "files must be a non-empty array"  (route reached)
POST /meetings/x/not-a-real-route → 404 "unknown meeting action"    (the control)
```

Same precedent as TASK-1934 AC-5 → TASK-1941: a mis-derived criterion is corrected in the open, not ticked quietly and not left to rot.
