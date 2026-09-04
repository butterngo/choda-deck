---
type: gotcha
title: jsdom has no layout engine — component tests cannot see off-screen or lazy-image defects
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-08-05
lastVerifiedAt: 2026-09-04
affectedFeatureId: feature-companion-ui
---

## Trigger

Claiming a web change works when the claim is positional or visual — "the detail shows",
"the image renders", "it's in view" — backed only by the vitest/jsdom suite.

## Context

TASK-1570 shipped the Conversations view with 17 passing component tests. Every assertion
was true. The feature was still broken for a user: clicking a conversation appeared to do
nothing.

The list rendered ~300 rows unbounded, making the page ~10,900px tall. The detail pane
renders at the top of the right column, so selecting a row deep in the list left it far
above the viewport — measured at `top: -3502px`. And because capture images carry
`loading="lazy"`, an off-screen image is never fetched: `naturalWidth: 0`.

## Business rule

**jsdom can prove an element exists and carries the right attributes. It cannot prove
the user can see it.** No `getBoundingClientRect`, no viewport, no lazy-loading, no image
decoding — `naturalWidth` is always 0 there.

So these claims need a real browser, not a component test:

- anything about position, scroll, or visibility
- `loading="lazy"` behaviour
- whether an image's bytes actually loaded (`naturalWidth > 0` is the honest discriminator
  between a picture and a broken-image icon; `complete` goes true on failure too)
- overall page height / whether a list is bounded

## Resolution

Drive headless Chromium against the **built bundle** behind a static+proxy server — that
is the shape the Electron app ships, unlike `vite dev`. Measure, don't assert on markup:

```
document.body.scrollHeight        10,880px -> 900px
detail pane getBoundingClientRect().top    -3502px -> +140px
capture img naturalWidth                   0 -> 64
```

Keep a jsdom guard for the *presence* of the fix (TASK-1574 asserts the bounded-scroll
classes) so a refactor cannot silently drop it — but be explicit in the test's own comment
that it proves presence, not behaviour.

## Second instance — and a third option better than a presence guard (TASK-1786, 2026-09-03)

The same class recurred in the History tab: the commit detail pane was itself the
scrolling element, so an open file's header — path, sibling-file chips, "Back to diff" —
scrolled away with the code. Reported by a person, invisible to 431 green tests.

A presence guard would have stayed green through the whole defect: every element it
would have asserted on was present and correct the entire time.

**When the visual claim is caused by structure, assert the structure — not the position,
and not merely the presence.** The defect's cause was "a scrolling element sits between
the back control and the pane." That is fully checkable in jsdom by walking
`parentElement` from the control up to the pane and testing each ancestor's classes, and
it is the cause rather than a proxy for it.

The discipline that makes it a real check, not a reassuring one: **injection**. Restoring
`overflow-y-auto` on the pane turned exactly the four new tests red and left the other 34
green. A structural assertion that cannot be made to fail is the same empty guarantee as
the presence guard it replaced.

This does not retire headless verification — the human still had to look, and AC-1 was
ticked on eyes, not on the suite. It narrows what has to wait for a browser.

## Honest limitation, worth stating

The headless harness that caught the first instance is not in the repo and nothing
re-runs it. A regression of the lazy-image / page-height class would still be caught by
nobody — the repo also has no CI.

## Related

- TASK-1573 — the headless verification that found it
- TASK-1574 — the fix (bounded list + detail panes in ConversationsView and KnowledgeView)
- TASK-1786 — the second instance; see the companion gotcha "A detail pane must not be the scrolling element"
- `choda-deck-companion/docs/reports/task-1574-ac-verification.md`
