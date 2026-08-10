---
type: learning
title: Sweep threshold constants against real fixtures — a guessed cutoff lands on the data
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-08-08
lastVerifiedAt: 2026-08-08
---

## Trigger

A fix needs a numeric threshold — a window size, a minimum length, a timeout —
and the plausible-looking round number is right there.

## Context

`dedupe_lines()` in `/choda-watch` had to drop caption-scrolling repeats without
deleting speech the speaker actually repeated. Two constants: how far back to
look, and how long a line must be before a repeat counts as an artifact.

## Two failures, both from guessing

**First guess — no length floor at all.** Widening the window (what INBOX-1694
proposed) deleted 8 genuine words across the two T1 transcripts: `Um`, `Great.`,
`process`, `triggered`. Real speech, gone. Caught only because a criterion
demanded T1 output stay byte-identical.

**Second guess — a 25-character floor.** It sat one character above a real
artifact: `"to do Track II dialogues"` is 24 characters. The bug it was meant to
fix walked straight through.

## Business rule

A threshold sits on a distribution you have not looked at. Sweep it across the
plausible range against real fixtures and read where the behaviour actually
changes, rather than picking a number that sounds reasonable and testing only
that one.

## Resolution

Swept floors 0→25 and windows 6→30 against three cached transcripts:

- **15 is the smallest floor** that leaves both T1 transcripts byte-identical.
  Below it, the Stanford lecture starts losing real words.
- **Above ~22 the artifacts return** (the shortest real one is 24 chars).
- Window size is insensitive across 6→24, so it stayed at the modelled scroll
  distance rather than being tuned to nothing.

Result on the TED talk: 9 repeated sentences → 0, against the 2 the bug report
knew about. Both constants and their derivation are recorded in the docstring, so
the next person changing them knows what the numbers are load-bearing for.

## Source

TASK-1585, from INBOX-1694.
