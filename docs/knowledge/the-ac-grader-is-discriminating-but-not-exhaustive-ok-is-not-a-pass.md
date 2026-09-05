---
type: learning
title: The AC grader is discriminating but not exhaustive — ok is not a pass
projectId: choda-deck
scope: project
refs:
  - path: src/adapters/companion/ac-review.ts
    commitSha: 824df76cd5e9230aa39d4e67470905623188b23d
createdAt: 2026-09-05
lastVerifiedAt: 2026-09-05
---

**Trigger:** you press *Grade against the standard* on a task, read a list of `ok` verdicts, and conclude the acceptance criteria are sound.

**Context.** `POST /tasks/ac-review` (TASK-1860) grades each criterion under `## Acceptance` against `/choda-plan` §3d's five tests. Two live runs against the configured model on 2026-09-05 measured what it actually catches.

**What it caught.** On a deliberately mixed five-criterion probe it was precise:

- *"The sync handler works correctly under load"* → `weak`, citing test (2), *"does not specify where to look"*
- *"The export writes a valid file **and** the import reads it back"* → `weak`, citing test **(3) one verdict** by name, and splitting it into AC-3a / AC-3b
- *"The UI is robust"* → `weak`, test (2)
- Two well-formed criteria naming their surfaces → `ok`

Every flag it raised was fair. On TASK-1839's real ten it also raised one worth having: AC-2's *"returns 400 and writes nothing"* → *"'writes nothing' does not specify where to observe that nothing was written"*, with the rewrite *"leaves the target file's bytes unchanged on disk (hash remains identical)"*.

**What it missed, and this is the point.** In that same ten-criterion run it graded TASK-1839's own AC-7 as `ok`:

> *"`POST /claude-config/review` with no key returns 501 and makes no provider call; against a stubbed provider failure it returns 502."*

Two distinct scenarios in one checkbox — a plain test-(3) violation, of exactly the kind it had just demonstrated it can name and split. The capability was present and did not fire.

**The rule.**

> A `weak` verdict is trustworthy. An `ok` verdict is weak evidence: it means *nothing was flagged*, not *this criterion is sound*.

Read the grade as a filter that finds some problems, never as a certificate that there are none. It belongs beside a human's judgement, not in front of it.

**Consequence in the UI.** The block is labelled *"From the model — judgement, not a check"*. That label is load-bearing rather than decorative, and it is the only thing standing between an `ok` list and a false sense of having verified something. See the structural sibling: `a-model-s-note-must-not-share-a-shape-with-a-deterministic-finding`.

**Unmeasured, and the obvious next experiment.** The miss happened on a ten-item batch; the catches happened on a five-item one. Whether recall degrades with batch size — and whether grading one criterion per call fixes it — has not been tested.

**Related.** `three-ways-an-acceptance-criterion-is-broken-and-only-the-third-survives-review` (bpa-engine) catalogues by hand the failure kinds this grader tries to catch automatically. It is the better reference for *what* to look for; this note is about *how much* to trust the automation.
