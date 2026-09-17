# AC verification — TASK-1990: Spike: prove Azure Speech transcribes a real VI/EN meeting track, and record the engine + audio-egress ADR

**Verdict:** 3/5 verified · IMPLEMENTED, not DONE — AC-1 and AC-2 were attempted and not proven; Butter chose not to re-run them
**Date:** 2026-09-17 · **Session:** SESSION-1789615972536-1 · **Commit:** b262c72

## 1. Summary

| # | Criterion | Class | Verdict | Proof |
|---|-----------|-------|---------|-------|
| 1 | Planted phrase found in mic, absent in loopback | machine | ❌ not proven | phrase transcribed as "Banana steve job." → exit 1 |
| 2 | Planted phrase offset within 2000 ms of the noted moment | machine | ❌ not proven | depends on AC-1; noted time contradicts recording length |
| 3 | Output names the API and sent-as-stored vs transcoded | machine | ✅ | fast-transcription, WebM/Opus as stored, HTTP 200 on 25-min tracks |
| 4 | ADR records engine, API, egress + consent, per-track mitigation | machine | ✅ | ADR file read section by section |
| 5 | Butter's verdict on VI/EN usability recorded in the ADR | decision | ⚠️ | go-with-limits, based on a note hand-drafted from the transcript |

✅ proven · ⚠️ proven with a caveat · ❌ failed · ⛔ blocked · 👤 needs a human

## 2. Done — what is proven

- **AC-3** (EVT-1789633152665-2). `scripts/proof-speech.mjs` against meeting `m-mu57vo0m-imo2oh` (25:31, a real bilingual client call) printed `api: fast-transcription (api-version 2024-11-15)` and `input: mic.webm sent as stored (audio/webm, 24780295 bytes, not transcoded)`; loopback likewise at 24,762,013 B. Both answered 200 (46.1 s / 41.7 s) with 38 / 36 phrases. **Discriminator:** a refused container returns a 4xx with no phrases. A 2 s clip returned 422 NoLanguageIdentified, not 415, so the error path is distinguishable from success. No transcoding was needed, so there is no dependency to name.
- **AC-4** (EVT-1789633154811-3). `docs/knowledge/adr-meeting-transcription-azure-speech-fast-per-track-audio-leaves-the-laptop.md` names the engine (§1), the API and route (§2), egress to `eastus` with the CONV-1789453938305-1 consent basis (§5), and per-track transcription as the VI/EN mitigation (§4). This was checked by reading the file, not its title.

## 3. Not done — what is NOT proven

**Failed**
- **AC-1.** Recording `m-mu59qywr-tuh744`: the mic track came back as a single phrase, `[00:01.12] "Banana steve job."`. With locales `vi-VN,en-US` the engine assigned `vi-VN` and mis-heard "seventeen". The script returned exit 1 (not found) rather than a false pass, so the discriminator behaved correctly and the criterion is simply unmet. The loopback track was silent and returned 422, so the negative half was never exercised against a positive.
- **AC-2.** Not reachable without AC-1's match. Separately, Butter noted the phrase at 00:10, but the recording is 3.4 s long (adapter `startedAt` 08:29:45.9 → `endedAt` 08:29:49.3; Azure measured 3,300 ms). The noted moment and the recording cannot both be right.

**Not run**
- A re-run with the phrase spoken slowly over a full 30 s recording (option A) was offered. Butter declined.

**Proven with a caveat**
- **AC-5** (EVT-1789633156676-4). Verdict **go-with-limits**, recorded in ADR §6. Caveat: Butter judged a note Claude **drafted by hand** from the real transcript ("tôi thấy cái report đó ngon rồi"), not output of the not-yet-built TASK-1992 route. The limits observed are recorded in the ADR and written into TASK-1991/1992/1994 as acceptance criteria.

## 4. Blockers — what stopped verification

- None environmental. AC-1/AC-2 are open by Butter's decision after one failed attempt, not because anything was unavailable.

## 5. Needs a human — what this skill structurally cannot prove

- **AC-1/AC-2, if revisited.**
  1. Record at least 30 s in the installed companion.
  2. Say the planted phrase slowly at about 00:10 and note the strip timer at that moment.
  3. Press Stop after 00:30.
  4. Run `node scripts/proof-speech.mjs <id> --track mic --expect-at 00:10`, then the same with `--track loopback`.
  5. Pass condition: exit 0 on mic, exit 1 on loopback.

  If "seventeen" keeps coming back as "steve job", a Vietnamese planted phrase would exercise the same property. That would be a wording discrepancy to record in the evidence, not a silent reinterpretation.
- The timing of the ▶ seek is re-tested as a human criterion in TASK-1993 AC-4 on the real app.

## 6. Steps — what was actually done, in order

1. Pre-flight: `GET {endpoint}/speechtotext/v3.2/models/base` → 200 (key valid); `POST …/transcriptions:transcribe` with no body → 415 (route reachable). The key had been pasted into `AZURE_SPEECH_ENDPOINT_ID`; Butter moved it. Region not required; resource is `AIServices` in `eastus`.
2. Smoke run on a 2 s dev meeting → 422 NoLanguageIdentified. The container was accepted.
3. Two recordings by Butter never reached the adapter. Diagnosis via CDP on the installed app (`--remote-debugging-port=9222`): the probe saw no recorder calls because Butter was recording in a different Companion window. Once in the debug-launched window, recording `m-mu51gjar-jc3ez6` uploaded cleanly (chunks + finalize all 200). **Not a recorder bug.**
4. Real 25-min call `m-mu57vo0m-imo2oh` transcribed per track: 200/200, as stored, every phrase and word timed. No planted phrase was said.
5. **Rejected check:** running the script with a mic-only sentence taken from that transcript as the "planted" phrase. It would pass by construction, because the needle came from the output under test. Not used.
6. Hand-drafted a meeting note (EN, then VI, client name "Chị Kate" supplied by Butter) from the transcript; Butter judged it usable → AC-5.
7. ADR + script committed (b262c72); AC-3/4/5 ticked.
8. Planted-phrase recording `m-mu59qywr-tuh744` → "Banana steve job.", exit 1 → AC-1/AC-2 not proven. Butter declined a re-run.

## 7. Findings

- ⚠️ **Noted time vs recording length disagree** (00:10 noted, 3.4 s recorded). Either Stop was pressed early or the recording strip's timer does not reflect recorded time. If it is the timer, every ▶ in a note inherits the error. Filed to the inbox against TASK-1966.
- ⚠️ **Loopback is "whoever is on the other end", not one person.** The client call became an internal debrief at 17:20 on the same recording. A note that merges parts would attribute internal remarks to the client. Now a TASK-1992 contract field (`parts[]`).
- English domain terms inside Vietnamese sentences are mis-heard (competency → "comparency"/"confessency", assessment → "assetment", seventeen → "steve job"). Every phrase was labelled `vi-VN`. → glossary in TASK-1992.
- Azure phrases have a median length of ~28 s, too coarse for a ▶ seek; word offsets are present. → TASK-1991 splits by word timings.
- Numbers disagree with themselves (competency count "5" and "8"). → ⚠ conflict flag in TASK-1992.
- Two phrases look like text invented from silence ("Chúng tôi xin được.", "Thấy thấy đum đum đum.").
- Workflow friction: `ac_check` with a worktree `cwd` fails `WORKSPACE_RESOLUTION_FAILED`; the main checkout path plus an explicit `sessionId` works.
- Client meeting content (transcript, EN and VI drafts) exists only on Butter's Desktop and in the session scratchpad. None of it is committed.
