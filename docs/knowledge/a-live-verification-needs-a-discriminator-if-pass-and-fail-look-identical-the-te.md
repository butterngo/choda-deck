---
type: learning
title: A live verification needs a discriminator — if pass and fail look identical, the test proved nothing
projectId: choda-deck
scope: project
refs:
  - path: extension/popup.js
    commitSha: 5dceb68edead33830d8e47b092213d980d9992c5
  - path: extension/lib/provenance.js
    commitSha: 5dceb68edead33830d8e47b092213d980d9992c5
createdAt: 2026-07-31
lastVerifiedAt: 2026-07-31
---

## Trigger

Verifying a human-driven change where the output is a single value you cannot
independently derive — a URL, an id, a timestamp — and the check "looks green."

## Context

TASK-1552 live-verified TASK-1551's capture-provenance fix: the panel must stamp a
capture's origin when the content is grabbed rather than read it at send. Every
acceptance criterion produced the same shape of evidence — a Source line and a
title naming some page.

That shape is exactly what the OLD bug produced too. A well-formed URL naming the
wrong page is indistinguishable, at a glance, from a well-formed URL naming the
right one. Two renderings of one value agreeing with each other is not
corroboration; it is one fact printed twice.

The trap bit twice in one session:

- **CONV-1785486085981-23** — the first honest-looking AC-1 candidate. Title and
  Source agreed. Ticking there would have recorded a pass without knowing whether
  the named page was the grab page or the post-navigation page.
- **CONV-1785486910422-29** — the first AC-4 attempt (pasted image must not inherit
  the grabbed screenshot's stamp). Grab page and send page were both the same
  `/edit` URL, so an inherited stale stamp and a correct send-time read emit
  byte-identical output. The test could not fail. It was re-run, not ticked.

## Business rule

A verification step earns a tick only when a wrong implementation would have
produced *visibly different* output. Before running a live check, name what the
failure would look like. If the answer is "the same thing," the check is theatre —
redesign it before spending a human's attention on it.

Corollary: never close the gap with the operator's recollection of the click order.
Memory of a sequence performed sixty seconds ago is exactly the evidence that feels
strongest and holds least.

## Resolution

Find a discriminator *inside the artifact* — some payload the code under test did
not author, which can contradict the field being checked:

- **Image captures** — read the PNG. The pixels are the grab moment, frozen. AC-1
  resolved because the screenshot showed a workflow editor while a failure would
  have shown the list page. AC-4 resolved because the pasted image showed the
  ichiba desktop while its Source read `cohere.com`.
- **Text captures** — the `# ${document.title}` prefix that `grabText` writes.
  It comes from the grabbed page, so it can disagree with a wrong Source.
- **Hand-typed text** — has no origin of its own, so the discriminator is a
  *negative*: AC-3 held because the Source was NOT the last-grabbed page, ruling
  out a stale stamp.

Where the artifact carries nothing that can disagree, engineer the difference into
the run: choose page A and page B so the two candidate answers are visibly
distinct, then the output reads as its own proof.
