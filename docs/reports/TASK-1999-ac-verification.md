# AC verification — TASK-1999: Transcribe route: a silent track must yield zero segments, not fail the whole meeting

**Verdict:** 4/4 verified
**Date:** 2026-09-17 · **Session:** attended (Butter)

## 1. Summary

| # | Criterion | Class | Verdict | Proof |
|---|-----------|-------|---------|-------|
| 1 | mic speech + loopback NoLanguageIdentified → 200, only mic segment | machine | ✅ | stub test; injection reddened it; also proven on real Azure |
| 2 | both tracks NoLanguageIdentified → 200, `segments: []`, file written | machine | ✅ | stub test; injection reddened it |
| 3 | any other 422 (InvalidAudioFormat) → 502, transcript sha256 unchanged | machine | ✅ | stub test; injection reddened it |
| 4 | a 500 on one track → 502 as before | machine | ✅ | stub test |

## 2. Done — what is proven

- `meeting-transcribe.test.ts` has four new tests, one per criterion, run over a real companion server against an HTTP stub for Azure. The stub now answers each track with a chosen status and body.
- **Discriminators (Test Plan injections, run and restored):**
  - Downgrading **every** 422 turned only AC-3 red.
  - Downgrading **no** 422 turned AC-1 and AC-2 red.
- **Real surface:** the fixed adapter (dist bundle on port 7439, real data dir) transcribed `m-mu59qywr-tuh744`, the 3.4 s recording with a silent loopback that Butter hit in the TASK-1993 walk.
  - Real Azure answered 200 with one mic segment: `"Banana steve job."` at 1120 ms.
  - Before the fix, the same meeting failed with `loopback: HTTP 422 … NoLanguageIdentified`.

## 3. Not done

Nothing is open.

## 4. Blockers

None.

## 5. Needs a human

Nothing. The criteria are all machine-checkable, and the real-Azure run was driven by script.

## 6. Steps

1. **Change.** `transcribeTrack` returns `[]` when a track answers 422 and the body's `innerError.code === 'NoLanguageIdentified'`. Every other non-2xx is still a `TranscriptionError`.
2. **Tests.** Extended the stub to answer `{status, body}` per track and added four AC tests. The suite is at 11/11: the 7 existing tests are unchanged and still pass.
3. **Injections.** Ran both and restored the code.
4. **Gates, run bare:**
   - typecheck: pass
   - lint: pass
   - `build:companion`: pass
   - full suite, first run: exit 1. All 2137 listed tests passed, but a vitest worker fork crashed while running `docker-exec.test.ts` (untouched by this change). That file passes 22/22 alone twice, and the full rerun passed with exit 0 (158 files, 2141 tests).
5. **Real-Azure run.** Ran against `m-mu59qywr-tuh744`, then stopped the temporary adapter.

## 7. Findings

- The first full run failed with `Worker exited unexpectedly`, attributed to `docker-exec.test.ts`. That is the worker-fork flake class already described in `/choda-burn-backlog`; the file passes alone and on the rerun.
- The real mic transcript still reads "Banana steve job." for "banana seventeen". This is the known mis-hearing of English inside Vietnamese audio (TASK-1990 ADR), not this defect.
