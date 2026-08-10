---
type: learning
title: When the input cannot be classified, report UNKNOWN — never fall through to a default
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-08-08
lastVerifiedAt: 2026-08-08
---

## Trigger

You add a new field to a payload that a classifier reads, and older cached or
persisted payloads do not carry it.

## Context

`/choda-watch` gained index mode, which classifies a video as course-shaped from
its `chapters` array. Six cached transcripts predated that field entirely.

## What went wrong

The classifier read `chapters` as absent, concluded "not course-shaped", and
reported `mode=thesis` — confidently, with no signal that it had classified
nothing. A stale cache would quietly produce the wrong note shape.

That is a **guess presented as a detection**, which is precisely the failure the
feature exists to prevent. It is also the same family as the capture-provenance
defects (TASK-1549/1551): output that is confidently wrong is worse than output
that admits it does not know, because nothing prompts a second look.

## Business rule

Absent input and negative input are different states. A classifier must
distinguish "I looked and the answer is no" from "I could not look." Only the
first justifies a verdict.

## Resolution

Detection now checks whether the field is present at all, separately from its
value:

```
unknown = "chapters" not in payload
...
elif unknown:
    payload["mode_source"] = "UNKNOWN — cache predates chapter capture, re-run with --no-cache"
```

The mode still defaults to thesis so the run can proceed, but the source string
says it was not detected and names the fix. The mode is printed on every run, so
this is visible before the note is written rather than after.

## Source

TASK-1586. Found while verifying AC-2/AC-3 against cached fixtures.
