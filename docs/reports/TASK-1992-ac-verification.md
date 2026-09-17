# AC verification — TASK-1992: Adapter: POST /meetings/:id/note/draft — AI drafts the meeting note, every item anchored to a transcript timestamp

**Verdict:** 10/10 verified · DONE once merged
**Date:** 2026-09-17 · **Run:** `/choda-burn-backlog`, unattended

## 1. Summary

| # | Criterion | Class | Verdict | Proof |
|---|-----------|-------|---------|-------|
| 1 | Item outside every segment → dropped `outside-segments` | machine | ✅ | A kept, B@15000 dropped; injection reddened it |
| 2 | Item with no atMs → dropped `no-timestamp` | machine | ✅ | action moved to dropped |
| 3 | Client name from request, not model | machine | ✅ | line 1 has Acme, not the model's Globex |
| 4 | Not transcribed → 409, no model call | machine | ✅ | call counter 0 |
| 5 | Headings from the vi/en table, in order, no cross-language heading | machine | ✅ | both languages checked |
| 6 | 754000 ms renders `▶ 12:34` | machine | ✅ | decision row |
| 7 | Internal parts dropped unless `includeInternal` | machine | ✅ | B@20000 dropped / kept; injection reddened it |
| 8 | Glossary applied by the adapter | machine | ✅ | "comparency" absent; injection reddened it |
| 9 | Disagreeing number values → `conflict` + ⚠ | machine | ✅ | 5 vs 8 flagged, single value not |
| 10 | Draft writes nothing | machine | ✅ | every file's sha256 unchanged |

## 2. Done — what is proven

`src/adapters/companion/meeting-note.test.ts` has 12 tests, one per criterion plus the second half of AC-5 and AC-7. They run over a real companion server, with an injected model transport that counts calls and returns a scripted answer. The stubbed model is deliberately **wrong** where a criterion is about the adapter overruling it:
- it cites a timestamp outside the recording (AC-1);
- it names the wrong client (AC-3);
- it ignores the glossary (AC-8).

**Discriminators (Test Plan injections, each run and restored):**
- removing the segment check → only AC-1 red (1 failed | 11 passed);
- removing the internal-part filter → only AC-7 red;
- skipping the adapter's glossary replacement, so the glossary reaches the model only → only AC-8 red.

## 3. Not done — what is NOT proven

- **Failed:** none.
- **Not run:** the optional live smoke against the real meeting `m-mu57vo0m-imo2oh`, compared with Butter's approved hand draft. It is not an AC. Unattended, it would send client content to the model with no one reviewing the output. It belongs to TASK-1994 AC-10 (human).
- **Proven with a caveat:** the tests prove the adapter's rules. They cannot prove the **quality** of what a real model writes. That judgement stays with Butter in TASK-1994 and TASK-1996.

## 4. Blockers

None.

## 5. Needs a human

No criterion in this task. The quality of a real draft is checked in TASK-1994 AC-10 and TASK-1996 AC-2/AC-3.

## 6. Steps

1. Research: `askAzureJson` (schema-strict call, `AiError` kinds including `parse` and `budget`); `resolveAzureConfig(dataDir)`; `ac-review` route and its injected-fetch test style.
2. Implemented `meeting-note.ts`:
   - request validation;
   - the strict JSON schema the model must answer in;
   - `enforce()`, which runs the anchor checks in the order no-timestamp → outside-segments → internal-part, applies the glossary and detects number conflicts;
   - `renderMarkdown()`, which builds the headings from the language table and the title from the request.
3. Wired the three-segment path `/meetings/:id/note/draft` into `meetings.ts` before its two-segment check, and passed `dataDir` and `fetchImpl` from `http-server.ts`.
4. Gates, each run bare: typecheck; targeted tests (35 across three files); full suite (158 files / 2137 tests, exit 0); lint; `build:companion`.
5. Three injections run and restored.

## 7. Findings

- The model retry happens **only** on a `parse` failure. Auth, rate-limit, network and budget errors return 502 with their `kind` immediately, because retrying at once cannot fix them.
- Parts: a timestamp not covered by any declared part is treated as `client`. Only an explicitly `internal` span is excluded.
- A number is kept if at least one of its values anchors. Its `atMs` is the earliest anchored value, and `conflict` compares only the anchored values.
