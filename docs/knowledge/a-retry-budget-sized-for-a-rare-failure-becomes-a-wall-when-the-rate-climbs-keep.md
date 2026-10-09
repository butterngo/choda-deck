---
type: learning
title: A retry budget sized for a rare failure becomes a wall when the rate climbs — keep each part's success across attempts
projectId: choda-deck
scope: project
refs:
  - path: src/adapters/companion/meeting-transcribe.ts
    commitSha: ba3d73afa9711bbbad7dd5a9a54e5f25f2b9b70c
createdAt: 2026-10-05
lastVerifiedAt: 2026-10-05
---

## Trigger

A request is made of N independent parts that must all succeed together, and each part is retried a small fixed number of times because the failure was rare when the retry was designed.

On 2026-10-05 meeting `m-muurjxss-rsc2j9` failed three transcribe presses in a row with `implausible-timings`. Azure fast transcription returned 9 of 14 responses with at least one collapsed phrase: the phrase and all of its words shared one offset with a 10 ms duration. Each track (mic, loopback) had come back clean at least once: mic on press 1, loopback on press 3. But each press needed **both** tracks clean, gave each track only 2 tries, and threw away the clean half when the other track failed. At that failure rate, one press succeeded about 35% of the time.

## Context

`handleTranscribe` sends the two tracks as separate requests. The retry (TASK-2011 follow-up) was sized after two isolated incidents on 2026-09-17 and 2026-09-22, when one retry was enough.

## Business rule

When the work splits into independent parts, a part's verified success must outlive the attempt that produced it. Persist the success keyed by the part's exact input. Retry only the parts that are still missing. Do not size the retry budget against the failure rate you have seen so far.

## Resolution

PR #326 (v0.7.0):

- A track that passes the physics check is written to `clean-<track>.json`, keyed by the audio's sha256 and the locales. It is re-checked on read.
- The next press asks Azure only for the missing track.
- The caches are deleted once `transcript.json` is written, so a deliberate re-run still re-transcribes.
- `MAX_TRACK_ATTEMPTS` was raised from 2 to 5.
- The 502 response names `cleanTracks`.

Related: `check-derived-timings-against-physics-before-persisting-them` (detection). This entry covers recovery.
