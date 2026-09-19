---
type: learning
title: Check derived timings against physics before persisting them
projectId: choda-deck
scope: project
refs:
  - path: src/adapters/companion/meeting-transcribe.ts
    commitSha: 
  - path: src/adapters/companion/meeting-transcribe-plausibility.test.ts
    commitSha: 
createdAt: 2026-09-19
lastVerifiedAt: 2026-09-19
---

**Trigger:** you are about to write timings, offsets or durations that came from a third-party service and were then reshaped by your own code — transcript segments, waveform marks, frame indices, anything a user will later click to jump somewhere.

**Context.** On 2026-09-17 a transcription of a real 25-minute client meeting wrote segments that cannot exist:

```
mic       123 segments   18 over the speech-rate ceiling   worst: 395 characters inside 10 ms
loopback  130 segments    0
          16 mic segments sharing the single start offset 767500
```

Nothing looked at them again. They fed a note draft, and the note reached the vault with ▶ stamps anchoring a Decision at 12:47 for a sentence spoken at 14:51 — **wrong by 2 minutes 12 seconds**. The error surfaced two days later, by accident, while running a spike proof that was expected to be paperwork.

The first diagnosis was wrong and is worth recording: the parser was blamed. Replaying `splitPhrase` over a fresh Azure response for the *same* audio produced 127 segments, 127 distinct starts, none under 50 ms, and placed the phrase at exactly the offset Azure gives. The fresh response was clean too — 38 phrases, 2794 words, zero duplicate offsets, perfect token alignment. **The corruption was one transient response, and it does not reproduce.**

**Business rule.** A derived timing must be checked for physical possibility at the moment it is written, not reasoned about afterwards. Transience is precisely why: a bad response you cannot reproduce is one you cannot debug later, and the only place you are guaranteed to be holding the evidence is the instant before you persist it.

A wrong timestamp is worse than a missing one. Missing, the reader knows nothing and checks elsewhere. Wrong, it invites the reader to verify a decision and then sends them to the wrong minute — with no signal that anything is off.

**Resolution.** Refuse the write and fail visibly. `findImplausibleSegments()` rejects a segment whose text cannot fit its claimed span — over 100 characters/second, four times the fastest human speech — or which claims no time while carrying words. The route answers 502 `implausible-timings` and writes nothing; a visible, retryable failure beats a file that is quietly wrong.

**Calibrate against a known-clean control, or the threshold is a guess.** The same meeting's loopback track was clean: 18 flagged on mic, 0 on loopback. Without that second number there is no evidence the ceiling does not fire on ordinary speech, and a guard that cries wolf is switched off within a week.

Keep the corrupt artefact. It is preserved at `docs/reports/task-2011-corrupt-transcript-2026-09-17.json`, because Azure will not produce it again on request and deleting it would leave only a description of the failure.
