---
type: decision
title: "ADR: Meeting transcription — Azure Speech fast transcription, per track, and client audio leaves the laptop"
projectId: choda-deck
scope: project
refs:
  - path: scripts/proof-speech.mjs
  - path: src/adapters/companion/meetings.ts
createdAt: 2026-09-17
lastVerifiedAt: 2026-09-17
---

- **Status:** Accepted
- **Date:** 2026-09-17
- **Context:** TASK-1990 (spike under epic TASK-1989, meeting recorder v2). Discovery: CONV-1789453938305-1 and `choda-deck-companion/docs/reports/meeting-recorder-bilingual-transcription-discovery.md`.

## Context

Meeting recorder v1 (TASK-1963) stores a client meeting as two WebM/Opus files per
meeting: `mic.webm` (Butter) and `loopback.webm` (everyone on the other end). v2 turns
that into a transcript and then a reviewed meeting note. Meetings mix Vietnamese and
English, often inside one sentence. Discovery flagged that Azure's continuous language
identification does not switch language mid-sentence. Before building any route, this
spike measured what Azure actually returns for a real meeting from this app.

## Decision

1. **Engine: Azure Speech.** The resource is kind `AIServices`, region `eastus`,
   addressed by its custom-domain endpoint. The region is not needed to call it.
   Credentials: `sensitive_information/azure-speech.txt`, referenced by path only.
2. **API: fast transcription** (`POST {endpoint}/speechtotext/transcriptions:transcribe?api-version=2024-11-15`,
   multipart `audio` + `definition`). It is synchronous and needs no storage account
   or blob URL. Batch transcription is not used.
3. **Audio is sent as stored.** The companion's `audio/webm;codecs=opus` bytes are
   accepted without transcoding, so there is **no new dependency** (no ffmpeg).
4. **Transcribe per track, never a mix.** Each track is sent separately with
   `locales: ["vi-VN","en-US"]`. The track supplies the speaker (mic = Me, loopback = Them),
   with no diarization.
5. **Client audio leaves the laptop and is processed in the USA (`eastus`).**
   Butter approved egress in CONV-1789453938305-1. Butter must tell participants
   the meeting is being recorded; the in-app recording indicator is the v1 reminder.
   If a client contract restricts where data is processed, that meeting must not be
   transcribed with this resource.
6. **Verdict on quality: go-with-limits.** Butter reviewed a note drafted from the real
   meeting transcript and judged it usable ("ngon rồi", 2026-09-17). The limits
   below are what downstream tasks must design around.

## Evidence (meeting m-mu57vo0m-imo2oh, 2026-09-17, 25:31, a real bilingual client call)

| Measure | mic | loopback |
|---|---|---|
| HTTP / latency | 200 in 46.1 s | 200 in 41.7 s |
| Input | 24,780,295 B WebM/Opus, as stored | 24,762,013 B WebM/Opus, as stored |
| Phrases / words | 38 / 2,794 | 36 / 2,562 |
| Every phrase and word has numeric `offsetMilliseconds` | yes | yes |
| Phrase duration, median / max | 27.9 s / 43.4 s | 29.2 s / 49.8 s |
| Locale assigned | all `vi-VN` | all `vi-VN` |

Earlier smoke run: a 2 s clip answered **422 NoLanguageIdentified**, not 415. The
container was accepted; there was simply no speech.

## Limits observed, and what they require downstream

- **English terms inside Vietnamese sentences are often mis-heard.** Every phrase is
  labelled `vi-VN`. Common terms survive (report, file, knowledge, scoring, mapping,
  feedback, platform, session), but domain terms break: competency → "comparency"/"confessency",
  rubric criteria → "pure ric retaria", assessment → "assetment" (6 of 10), mapping → "map pin",
  prompt → "prom". → TASK-1992 gives the model a per-project **glossary** and keeps every
  quoted claim anchored to a ▶ timestamp so a human can check it.
- **Numbers are the least reliable content.** The same count was transcribed as both
  "5" and "8", and a date came out as "ngày 2 6". → Key numbers in the note get a ⚠ flag
  whenever the transcript disagrees with itself.
- **Phrases are too long to seek with** (median ≈ 28 s). → TASK-1991 splits phrases into
  short segments using the per-word offsets rather than storing Azure phrases as-is.
- **Filler from silence** ("Chúng tôi xin được.", "Thấy thấy đum đum đum."). → Low-content
  segments must never become note items without an anchor that a human confirms.
- **Loopback is "the other end", not one person.** This meeting was a client call until
  17:20, then an internal call with a teammate on the same recording. → The note flow
  must let Butter mark part boundaries (client / internal) and exclude internal parts
  from a client-facing note by default.
- **Note language:** Butter wants the note in Vietnamese. → Language is chosen per meeting,
  default `vi`, and English domain terms stay in English.

## Not yet established

- Offset accuracy against a known planted moment (TASK-1990 AC-1/AC-2) was not measured
  on this recording, because no phrase was planted before the call started.
- Whether fast transcription accepts a phrase list to bias recognition toward domain terms
  was not tested.
- Local Whisper was not compared. With a go-with-limits verdict it is deferred, not rejected.

## Alternatives considered

- **Batch transcription:** needs a blob URL and a storage account, and is asynchronous.
  Nothing in this use case needs it.
- **Mixing both tracks before sending:** loses the free Me/Them separation and makes
  crosstalk worse.
- **Local Whisper (as in english-companion):** no egress, but it is a ~145 MB model and
  unmeasured on VI/EN. Deferred.
