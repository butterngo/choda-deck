---
type: gotcha
title: CommonMark eats backslashes in link destinations — normalize before parsing
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-08-05
lastVerifiedAt: 2026-08-05
affectedFeatureId: feature-companion-ui
---

## Trigger

Rendering markdown whose link or image destination may hold a Windows path — capture
bodies, task bodies, anything written by a tool that used `path.join` on Windows.

## Context

Capture entries written before TASK-1567 embed an absolute path:

```
![capture](C:\dev\choda-deck\data\artifacts\captures\ab12.png)
```

TASK-1569 added `CaptureMarkdown`, which resolves capture refs to `/api/artifacts/...`
via a `components.img` override. The resolver handled the legacy Windows form and its
unit test passed. The rendered `<img>` came out with **no `src` at all**.

## Business rule

**Normalize legacy/absolute paths in the markdown STRING, before it reaches the parser.
A `components` override is too late.**

CommonMark treats a backslash in a link destination as an escape character. By the time
react-markdown builds the AST, `![capture](C:\dev\...\ab12.png)` is an image node whose
url is gone — not wrong, *absent*. No component override can recover information the
parser already discarded.

## Resolution

`normalizeCaptureBody()` (`packages/web/src/lib/capture-refs.ts`) rewrites capture
destinations to their artifacts-relative form with a regex over the raw markdown, and
`CaptureMarkdown` applies it before `<Markdown>` sees the string. Component overrides
then only handle URL mapping and element choice, which is all they can reliably do.

Two details worth keeping:

- Legacy paths are re-based on the **last `captures/` segment**, not stripped by a fixed
  prefix — the artifacts root differs per machine and per profile, so there is nothing
  constant to strip.
- Pass-through is load-bearing and separately tested: an external URL that merely
  *contains* `captures/` must not be rewritten.

## The wider lesson

The resolver's unit test was green while the feature was broken. Two tests disagreed,
and only the one asserting on **rendered output** was telling the truth. When a
transform sits upstream of a parser, unit-testing the transform proves nothing about
what the parser leaves you.

## Related

- TASK-1569 — established this; `choda-deck-companion/docs/reports/task-1569-ac-verification.md`
- TASK-1567 — made new captures relative, so this affects legacy entries only
