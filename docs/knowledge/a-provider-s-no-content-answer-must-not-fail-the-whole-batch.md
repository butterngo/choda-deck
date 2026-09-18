---
type: learning
title: A provider's "no content" answer must not fail the whole batch
projectId: choda-deck
scope: project
refs:
  - path: src/adapters/companion/meeting-transcribe.ts
    commitSha: 
createdAt: 2026-09-18
lastVerifiedAt: 2026-09-18
---

**Trigger:** N inputs are sent to a provider in parallel and one of them is legitimately empty — a muted track, a blank page, a file with nothing in it. The whole operation fails and the inputs that DID have content are thrown away with it.

**Context.** TASK-1991 sent a meeting's two audio tracks to Azure fast transcription with `Promise.all` and treated every non-2xx as a `TranscriptionError`. Azure answers **422 `NoLanguageIdentified`** for a track with no speech. A meeting where the client joined late, or the mic was muted, produced one such track — so a meeting that was half recorded could not be transcribed at all. TASK-1990 had already SEEN that response for a 2 s silent clip and written it down as "container accepted, no speech"; the route simply did not carry the meaning forward, which is the part worth remembering.

**Business rule.** Distinguish "the provider processed this and found nothing" from "the provider failed". The first is a valid empty result for that input; the second is an error for the operation. Downgrade by the specific code only — never by the status class.

**Resolution.** `meeting-transcribe.ts` returns `[]` when the status is 422 AND `innerError.code === 'NoLanguageIdentified'`. Any other 422 (`InvalidAudioFormat`, say), and every other error, still fails the request and leaves the previous transcript byte-identical. The discriminating tests are worth copying: one input empty + one with content, both empty, a different 422, and a 500 — and the injection "downgrade every 422" must turn the different-422 test red.
