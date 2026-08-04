---
type: learning
title: Capture reduction may be lossy about VOLUME, never about IDENTITY
projectId: choda-deck
scope: project
refs:
  - path: extension/lib/noise-filter.js
    commitSha: 306045e706dad87bc85ee857b43c2154a7f69479
  - path: extension/lib/recorder.js
    commitSha: 306045e706dad87bc85ee857b43c2154a7f69479
  - path: src/adapters/companion/discovery-artifacts.ts
    commitSha: 306045e706dad87bc85ee857b43c2154a7f69479
createdAt: 2026-07-30
lastVerifiedAt: 2026-08-03
---

## Trigger

You are adding any reduction to a capture pipeline — collapsing, sampling, deduping, folding
— to stop a recording drowning in near-identical events. The question that decides whether
the reduction is safe: can a later reader still tell *what* was folded, or only *that*
something was?

## Context

Discovery recordings drowned in two noise classes (INBOX-1172: 20 apicalls, of which 3 were
telemetry beacons and 10 were an avatar asset fan-out — the same METHOD+origin+pathname with
differing query strings). `extension/lib/noise-filter.js` folds a fan-out into a single
event rather than emitting ten rows.

Folding destroys information. The design question is *which* information it is allowed to
destroy.

## Business rule

**Volume may be lost. Identity may not.** A folded event must carry enough evidence for a
reader to reconstruct what it stood for:

- `collapsed: <n>` — how many calls folded in, so "this happened 10 times" survives.
- `collapsedSamples` — up to 5 of the actual URLs, so a reader can see it was
  `Id=1..10` and not one call repeated for no reason.

Without the samples, a folded row is indistinguishable from a bug in the recorder. With them,
the reduction is legible and the reader can decide whether the fan-out mattered.

**Second invariant: reduction state is per-recording.** The collapser resets on `start()`, so
a key seen in run 1 can never silently fold a genuinely-first call in run 2. Cross-run
state in a deduping layer produces the worst possible failure — a call that *did* happen and
*was* the first of its kind, reported as a repeat.

## Resolution

`createCollapser()` in `extension/lib/noise-filter.js` implements both: `admit()` returns
false for a folded event while incrementing the first event's `collapsed` count and appending
to `collapsedSamples` (cap 5), and `recorder.js` constructs a fresh collapser on `start()`.

Pinned by tests: the INBOX-1172 replay asserts 20 raw apicalls → 8 events with no business
endpoint lost, and a separate case asserts the 10x fan-out becomes one event carrying
`collapsed: 10` plus 5 samples.

## Known limitation

Collapse is **irreversible in the artifact** — folded events are not recoverable from
`timeline.jsonl` afterwards; `collapsedSamples` (cap 5) is the only identity retained. If a
future reader needs the full set, that requires capturing before the fold, not recovering
after it.
