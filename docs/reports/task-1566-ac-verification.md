# TASK-1566 — AC verification

**Task:** Bridge: GET /artifacts/* serves capture files (token-gated, path-confined)
**Verified:** 2026-08-05 · session SESSION-1785907246863-1 · merge commit `d0c370d` (PR #239)
**Result: 8/8 verified · 0 needing a human · 0 blocked**

## Method

Criteria were proven against the **built artifact** (`dist/companion-server.cjs`), started
with `CHODA_DATA_DIR=/tmp/ac1566 CHODA_COMPANION_PORT=7399` over a real data dir holding a
real PNG, a HAR file and a nested `discovery-zz1/timeline.jsonl` — plus a real SQLite
database outside the artifacts root as the traversal target. The test suite was *not* used
as evidence for the criteria; it ran separately as a gate.

## Per-criterion

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | 200 + `image/png` + byte-identical body | ✅ | `cmp` of downloaded vs on-disk file identical, 70 bytes |
| 2 | Missing/wrong token → 401, no file bytes | ✅ | both variants 401; no PNG signature in body |
| 3 | `../..` traversal → 403, no SQLite bytes | ✅ | 403 `path escapes the artifacts directory`; 0 matches for `SQLite format 3` |
| 4 | `%2e%2e` traversal → 403 | ✅ | 403; encoded-slash `..%2f..%2f` variant also 403 |
| 5 | Missing file → 404 JSON, not 500 | ✅ | `{"error":"artifact not found"}`, `application/json` |
| 6 | Correct content-type per extension | ✅ | 3 confirmed live, all 10 in the test table |
| 7 | Nested discovery path → 200 | ✅ | `timeline.jsonl` served, body intact |
| 8 | Diff confined to `src/adapters/companion/**` | ✅ | `git show --stat d0c370d` — 4 files, all in-adapter |

## Findings

**1. The traversal criteria cannot be proven through a compliant HTTP client.**
`new URL()` — and `fetch`, and `curl` without `--path-as-is` — collapse dot segments
before the request is sent:

```
/artifacts/../../database/choda-deck.db         -> /database/choda-deck.db
/artifacts/%2e%2e/%2e%2e/database/choda-deck.db -> /database/choda-deck.db
/artifacts/..%2f..%2fdatabase/x.db              -> unchanged
```

A first implementation routed off `url.pathname` and a first test used `fetch`; both
produced **404, not the specified 403**. The DB was never served either way, so the test
was green-adjacent but proved nothing about the guard — the refusal came from the router's
fallback, not from any security check.

Fixed on both sides: the route matches the **raw `req.url`**, and the tests drive the two
traversal cases over a **raw socket** (`net.connect`, verbatim request line). Live
verification uses `curl --path-as-is`. This is the discriminator the criterion needed —
an attacker does not use a normalizing client.

**2. The new test file destabilized the whole suite, and nearly passed as a known flake.**
After the first green run the full suite reported `130 passed (131)` plus
`Worker exited unexpectedly` — superficially the documented worker-fork flake. It was not:
clean `main` gave `130 passed (130)` with no error, and excluding only the new file
restored it. Two real defects in the test's teardown:

- raw sockets were never `destroy()`ed, keeping the worker's event loop alive past `afterAll`
- `fs.rmSync` raced the server teardown on Windows (EBUSY), which kills the fork rather
  than failing a test

Both fixed (`sock.destroy()`, `rmSync` with `maxRetries`/`retryDelay` in a try/catch).
Final: `131 passed (131)`, 1586 tests, no worker errors.

## Gates

| Gate | Result |
|---|---|
| `pnpm run typecheck` | clean |
| `pnpm test` | 131 files / 1586 passed / 1 todo, no errors |
| `pnpm run lint` | clean |
| `pnpm run build:companion` | clean, 471.8kb |
| CI (ubuntu + windows) | both pass |
| Merge proof | `d0c370d` is an ancestor of `origin/main` |

## Process note

The branch was created without a preceding `session_start`; the session was opened
retroactively to record the AC checks, so its start timestamp lags the actual work.
Sequencing error on the runner's part, not a defect in the change.
