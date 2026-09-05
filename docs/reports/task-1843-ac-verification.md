# TASK-1843 — AC verification

**Adapter: the model call lives behind its own route — POST /claude-config/review**

Run: `/choda-burn-backlog`, iteration 3 · 2026-09-04
Merged: PR #267, squash `e29c4c2`, proven ancestor of `origin/main`
Gates: `typecheck` / `lint` / `build` exit 0, each run bare · `pnpm test` 1845 passed, 1 skipped, across 143 files (was 1829)
CI on PR #267: **watched to completion before merging** — ubuntu 1m14s, windows 1m51s, docker-image 44s, all pass

## Done — 7 of 7

| AC | Class | Proven by | Discriminator |
|---|---|---|---|
| AC-1 | machine | No key file, no `CHODA_AI_KEY` → 501, injected fetch records **zero** provider calls | The response is also asserted to carry no `notes` — the other half of the criterion is a 200 with fabricated notes, which a status-only check would miss |
| AC-2 | machine | Provider 500 → `kind: 'api'`; transport throw → `kind: 'network'`; 401 → `auth`; 429 → 429 with `rate_limit` | The kinds are asserted to **differ**. Equal kinds are what make a typed union decoration |
| AC-3 | machine | Non-JSON content and valid-JSON-wrong-shape both → 502 `kind: 'parse'`, no notes, no exception escaping | CONTROL: a well-formed answer returns its note. Without it, "parse" could be the only outcome |
| AC-4 | machine | A distinctive key is planted, the stub **echoes it back inside a 500**, and all three response bodies plus every captured console line are searched for it | CONTROL: the key is read back out of the recorded `x-api-key` header, proving it was in play — otherwise the search passes against a route with no key at all |
| AC-5 | machine | `/validate` driven with `ai=true`, `review=1` and an `x-ai` header, plus the inventory and a file read — provider calls stay at zero | Injection: folding review into `/validate` behind that flag reddens exactly this test. Parameters driven explicitly, because a route-table walk would miss a handler reading a header |
| AC-6 | machine | Seven attempts at the key file across `/claude-config` roots, `/artifacts`, `/vault`, `/workspace-docs` — each non-200 **and** carrying no occurrence of the key | The key lives in the data dir, which is not one of the four allowlisted roots |
| AC-7 | machine | The mint path writes the file, its contents match, and a stale env cannot override it | **Limitation stated, not hidden** — see below |

## AC-7, precisely

**Observed here:** `resolveAiKey` mints from `CHODA_AI_KEY`, writes the file, the contents match, and once persisted the environment is no longer consulted.

**Not observed here:** the `0o600` bits. Windows cannot represent them in `st_mode`, so that assertion is `it.skipIf(platform === 'win32')` — which is exactly what the criterion instructs, and it runs on the ubuntu CI job. The code passes `{ mode: 0o600 }`, mirroring `bridge-token.ts:34`.

## Findings

**A contradiction in the task's own body had to be resolved, not worked around.** AC-7 requires the adapter to *write* the key file; the Context says the key must *never come from a request*. Both hold only if the adapter writes it from something that is not a request — so `resolveAiKey` mirrors `resolveBridgeToken` exactly (read the file, mint if absent), with the mint sourced from `CHODA_AI_KEY` instead of randomness, because a key cannot be invented. `CHODA_AI_KEY` is how a key *arrives*; the file is where it *lives*.

**A provider error body is never forwarded.** The 502 carries the adapter's own message plus the kind. A provider can echo the request back, and forwarding it verbatim is how a secret reaches a log nobody thought was sensitive — which is why AC-4's stub deliberately echoes the key inside its 500.

**The file is read before the key is resolved.** The opposite order would leak *"this path exists"* through the 501, since a request for a path outside the allowlist must be refused whether or not a model is configured.

**One header was deliberately not copied.** `anthropic-dangerous-direct-browser-access` opts a *browser* past a CORS refusal. Sending it from Node would announce a risk this caller does not take, and a test asserts its absence.

## Process failure in this iteration

**I skipped §3 (session-start) entirely** — went from research straight to implementation — and the first `ac_check` therefore bound its evidence to **`SESSION-1786527042281-1`, the unrelated TASK-1638 spike session** left open since 2026-08-12. That is precisely the defect TASK-1577 describes, walked into by omission rather than by concurrency.

`EVT-1788510776894-160` is recorded against that session and cannot be moved. A session was then started properly and the remaining six criteria bound correctly to `SESSION-1788510793775-161`; re-recording AC-1 was refused with `AC_ALREADY_CHECKED`, so the mis-binding stands in the record and is named here instead.

## Not done

Nothing deferred. No criterion is human-class.

## Blockers unblocked by this task

TASK-1845 (the review UI) was blocked by this and by TASK-1844. TASK-1844 was already eligible, so after this the remaining chain is 1844 → 1845.
