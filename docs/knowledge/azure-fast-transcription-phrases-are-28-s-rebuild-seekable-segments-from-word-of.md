---
type: learning
title: Azure fast-transcription phrases are ~28 s — rebuild seekable segments from word offsets
projectId: choda-deck
scope: project
refs:
  - path: src/adapters/companion/meeting-transcribe.ts
    commitSha: 
createdAt: 2026-09-18
lastVerifiedAt: 2026-09-18
---

**Trigger:** you are storing a transcript so a timestamp can play the exact sentence back — evidence for a meeting note, a quote, a dispute.

**Context.** Measured on a real 25-minute bilingual call (TASK-1990, meeting `m-mu57vo0m-imo2oh`): Azure fast transcription returned **38 phrases on the mic track with a median duration of 27.9 s** and a maximum of 43.4 s. A ▶ built on phrases drops the listener half a minute before the sentence they asked for, which is useless as evidence.

The response also carries `phrases[].words[]`, each with `offsetMilliseconds` and `durationMilliseconds` — but the word texts carry **no punctuation**, while `phrase.text` carries punctuation and no timings.

**Business rule.** Segment boundaries come from word timings, not from the provider's phrases.

**Resolution.** Zip the phrase's whitespace-split tokens with `words[]`: they lined up one-to-one on 38 of 38 phrases, so the token supplies punctuation and the word supplies the offset. Close a segment at sentence-ending punctuation, or once it reaches a cap (12 s in `SEGMENT_MAX_MS`). When the counts do NOT line up, fall back to word text and the cap only: coarser, never wrong.

Result on the same call: **253 segments, median 6.6 s**. One segment still ran 34.7 s, because the cap is only tested when the next word arrives and a long pause therefore stretches a segment — acceptable, and worth knowing before someone treats the cap as a guarantee.
