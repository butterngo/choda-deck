---
type: learning
title: A grader's verdict must map back to a checkbox, and every criterion must get one
projectId: choda-deck
scope: project
refs:
  - path: src/adapters/companion/ac-review.ts
    commitSha: 824df76cd5e9230aa39d4e67470905623188b23d
createdAt: 2026-09-05
lastVerifiedAt: 2026-09-05
---

**Trigger:** you are editing `POST /tasks/ac-review` and one of two reasonable-looking changes occurs to you — widen the parser so the model sees the whole task body "for context", or return only the criteria the model actually commented on. Both are wrong, and both fail silently.

**Context.** The route grades the criteria under `## Acceptance` and returns a verdict per criterion, indexed. `ac_check` flips a checkbox by **index into that same section** — the first `- [ ]` under `## Acceptance` is index 0.

## Rule 1 — parse only the checkbox lines under `## Acceptance`

Not a token-cost decision. The index is the whole contract between a verdict and the thing it judges. Widen the parse and the indexes shift: a verdict about criterion 2 now points at a Test Plan checkbox, and **a verdict nobody can point back at a checkbox is a verdict nobody can act on**.

The section boundary is any following `##`, so `## Test Plan`'s checkboxes are excluded by construction rather than by a filter someone can forget. Both ticked and unticked lines are read — a DONE task's criteria are all `[x]` and must still be gradeable.

The injection that removes the boundary check reddens the parser test *and* the every-criterion test, which is how you know the two rules are coupled.

## Rule 2 — answer for every criterion, mentioned or not

The model is asked to return one entry per criterion and usually does. When it does not, the missing criterion must still appear in the response.

A criterion dropped from the response renders as **nothing at all**, and on screen nothing is indistinguishable from approval. That is the single direction this feature must never fail in — a grader that quietly says less than it was asked is worse than one that says nothing, because the reader cannot tell which happened.

The default for an unmentioned criterion is `ok`, and that is chosen as the lesser evil rather than as a claim: `ok` already means *nothing was flagged* rather than *this is sound* (see `the-ac-grader-is-discriminating-but-not-exhaustive-ok-is-not-a-pass`). Dropping it would have been a stronger, and false, statement.

The summary line — *"2 criteria, none flagged"* — exists for the same reason: a clean grade has to be a statement, not an empty area.
