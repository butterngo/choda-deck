# TASK-1936 — AC verification

**Adapter: POST /workspace-docs/diagram — the model call, gated on the parser**
Session SESSION-1789045987140-56 · PR #289 · merged `c157d9d`
Verified 2026-09-10 by the `/choda-burn-backlog` runner (unattended).

**Result: 8 / 8 ticked. Merge proven.**

## Per criterion

| AC | Verdict | Evidence |
|---|---|---|
| AC-1 unparseable twice → 422, nothing written | ✅ | `attempts: 2` with the parse error; the target file's sha256 identical before and after — the no-write property is **proven**, not assumed |
| AC-2 the retry is real | ✅ | junk-then-valid → 200 `attempts: 2`; the recorded second request body contains `did not parse`, so the retry carries the parser's complaint rather than re-asking the same question |
| AC-3 no retry when nothing failed | ✅ | first answer parses → `attempts: 1`, recorder holds exactly one call |
| AC-4 no key is the normal state | ✅ | 501, recorder empty, and no `mermaid` field — never a fabricated answer |
| AC-5 failures are distinguished | ✅ | HTTP 500 → `kind: api`; transport throw → `kind: network`; 429 passed through with `retry-after: 30` |
| AC-6 a bad index costs nothing | ✅ | `no fence 7: doc.md has 1`, zero calls — the fence is located **before** the key is read. Control: index 0 does reach the provider |
| AC-7 the cost boundary is the route | ✅ | see below — this one was wrong first |
| AC-8 the key never leaks | ✅ | fixture key absent from every body and log line across 200/422/502/501, **and** `calls.length > 0`, so it cannot pass by never configuring a key |

## The injection that found a defect in the test rather than the code

Both injections named in the task's Test Plan were run.

| injection | expected | observed |
|---|---|---|
| return the model's output without parsing | AC-1, AC-2 red | as predicted |
| fold the paid path into `/diagram/check?ai=true` | AC-7 red | **AC-7 stayed green** |

AC-7 was sending `{ mermaid }` as its body. Folded into the paid path, that
request died on a *missing field* — so the test asserted "no provider call
happened" and was right for a reason that had nothing to do with the route
boundary it claimed to prove. A criterion that could not fail, dressed as a
strict one.

**Fixed:** AC-7 now sends a body the paid route would **accept**, leaving route
separation as the only thing between it and the provider. Re-run against the same
injection: red. A control was added beside it, because "no call happens" also
passes on a build where the provider is unreachable for unrelated reasons.

This is the whole argument for running injections instead of trusting a green
suite. The code was correct; the test was not, and nothing else would have said so.

## Findings

1. **`resolveAzureConfig` throws rather than returning null on a malformed
   provider file** — deliberately, since a bad config is not "no provider
   configured". Caught in this handler so it surfaces as a stated 501 instead of
   a 500.

2. **`safeResolve` was exported from `workspace-docs.ts` rather than copied**, and
   `readRawBody` now comes from `atomic-file.ts`. Both for the same reason: a
   second copy of a guard is how one of them gets a fix the other does not.

3. **The parse gate proves parse, never render.** `mermaid.render` cannot run in
   the adapter at all. The browser preview in TASK-1937 is the only renderability
   proof, and it is a human's eyes.

## Gates

typecheck 0 · lint 0 · build 0 · full suite 2107 passed, 1 failed
CI on PR #289: ubuntu and docker green; **windows red only on
`pty-session.test.ts` AC-1 and AC-4** — the documented flake, which this change
does not touch (150/159 files pass, every file of this task's among them).

The one local failure was an intermittent 500 from the PUT route under parallel
load, filed as **TASK-1942** with the cause explicitly *not* established. That
file passes five consecutive runs in isolation.
