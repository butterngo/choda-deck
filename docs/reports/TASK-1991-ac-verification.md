# AC verification — TASK-1991: Adapter: POST /meetings/:id/transcribe — per-track Azure transcription merged into transcript.json

**Verdict:** 7/7 verified · DONE
**Date:** 2026-09-17 · **Session:** SESSION-1789634842314-12 · **Commit:** c38fa4b (PR #294)
**Run:** `/choda-burn-backlog`, unattended; this report was written in the TASK-1992 PR because #294 had already merged.

## 1. Summary

| # | Criterion | Class | Verdict | Proof |
|---|-----------|-------|---------|-------|
| 1 | Two tracks merge by time, speaker from track | machine | ✅ | mic@1000 Me, loopback@3000 Them, mic@5000 Me; injection reddened it |
| 2 | A long phrase splits at sentence ends via word timings | machine | ✅ | segments at 0 and 20000; injection reddened it |
| 3 | Unknown meeting → 404, no Azure call | machine | ✅ | stub call log empty |
| 4 | Not finalized → 409, no Azure call | machine | ✅ | stub call log empty |
| 5 | No key → 501, no credential value in body | machine | ✅ | body has neither endpoint nor host |
| 6 | Azure 500 → 502, audio + previous transcript unchanged | machine | ✅ | three sha256 identical |
| 7 | Re-run replaces text, transcribedAt moves forward | machine | ✅ | new text, later timestamp |

## 2. Done — what is proven

All seven criteria were run over a real companion server (`startCompanionServer`) against a real HTTP server standing in for Azure. That stub records every request, so "zero calls" is checkable. `src/adapters/companion/meeting-transcribe.test.ts` has one test per criterion. Events EVT-1789635339145-13 … EVT-1789635352366-19.

**Discriminators:**
- **AC-1:** removing the merge sort turned only this test red (1 failed | 6 passed).
- **AC-2:** storing the Azure phrase unsplit turned only this test red. The stub's word shape (timings, no punctuation) matches what Azure actually returned on meeting `m-mu57vo0m-imo2oh`.
- **AC-3/AC-4:** the recorder is proven live by AC-1 in the same file, where it records two calls.
- **AC-6:** a write-before-parse implementation would change `transcript.json`'s hash.

## 3. Not done — what is NOT proven

- **Failed:** none.
- **Not run:** the optional live smoke from the Test Plan (real meeting, segment median < 12 s). It is not an AC, and running it unattended would send client audio to Azure without Butter present.
- **Proven with a caveat:** none.

## 4. Blockers

None.

## 5. Needs a human

No criterion needs a human. The first real end-to-end use belongs to TASK-1993 AC-4 and TASK-1996.

## 6. Steps

1. Research: `meetings.ts` route shape and test style; Azure word/phrase shape measured on the real transcript. Phrase text tokens aligned 1:1 with `words[]` on 38/38 phrases.
2. Implemented `meeting-transcribe.ts`; wired `transcribe` into `meetings.ts`, `speechCredentialsFile` into the services.
3. Gates, each run bare: typecheck, targeted tests (23), full suite (157 files / 2125 tests), lint, `build:companion`.
4. Injections 1 and 2 run and restored.
5. PR #294, CI green on ubuntu, windows and docker; squash-merged; merge commit `c38fa4b` proven to be an ancestor of `origin/main`.
6. 7 × `ac_check`, `session_end`, then DONE.

## 7. Findings

- ⚠️ **Credentials location in a packaged install.** The default path is `<dataDir>/../sensitive_information/azure-speech.txt`. That is right for Butter's `CHODA_DATA_DIR=C:/dev/choda-deck/data`. A fresh install with an `%APPDATA%` data dir answers 501 until `CHODA_SPEECH_CREDENTIALS_FILE` is set. TASK-1996 must check this.
- `meeting-transcribe.ts` imports `meetings.ts` as types only, because `meetings.ts` imports it back.
- The worktree directory could not be deleted after `git worktree remove` (Windows lock). It is empty and harmless.
