---
type: learning
title: Deciding to change nothing still obliges you to check that what you are keeping works
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-08-08
lastVerifiedAt: 2026-08-08
---

## Trigger

A design question is answered "leave it as it is" — the status quo wins on
merit, and the task looks like pure documentation from there.

## Context

TASK-1588 asked whether `/choda-watch` notes built from T2 (non-YouTube) caption
sources should structurally hedge. The answer was no: judgement had already
produced the right result on the TED note without a rule, and a note that always
hedges trains the reader to skip the hedge.

## What the "no" surfaced

Writing the decision down meant reading the guidance being kept. It said:

> `tier: T2` with `captions: auto` means machine-transcribed text — lean harder
> on the **Unclear** section.

That condition **cannot be satisfied**. T2 always reports `captions: unknown`;
`auto` only ever appears on T1. Verified across all six cached transcripts —
every `auto` is T1, the sole T2 is `unknown`.

So the one rule that appeared to cover T2 had never fired, on any run, since it
was written. A literal "keep as-is" would have preserved a dead rule while
recording that the area had been reviewed — which is worse than not reviewing
it, because the record implies coverage that does not exist.

## Business rule

"No change" is a decision about the *future*, not a certificate about the
present. Before recording it, verify the thing being preserved actually does what
it claims. A rule whose precondition cannot occur is indistinguishable from no
rule, except that it looks like one.

## Resolution

Split the two signals, since neither implies the other — `captions: auto` is
machine-transcribed and T1-only; `captions: unknown` always means T2 and should
be treated as possibly machine-made. No hedging added beyond that. Decision and
its reopen condition recorded inline in SKILL.md.

## Source

TASK-1588, from INBOX-1695. Shipped in PR #2 of butterngo/choda-skills.
