# TASK-1841 — AC verification

**Adapter: save a config file — if-match, and only what the human changed**

Run: `/choda-burn-backlog`, iteration 1 · 2026-09-04
Merged: PR #264, squash `30080b4`, proven ancestor of `origin/main`
Gates: `typecheck` / `lint` / `build` exit 0, each run bare · `pnpm test` 1814 passed across 141 files (was 1803)
CI on `main` for `30080b4`: **success** — `build-and-test (ubuntu-latest)`, `build-and-test (windows-latest)`, `docker-image`

## Done — 6 of 6

| AC | Class | Proven by | Discriminator |
|---|---|---|---|
| AC-1 | machine | Raw-socket `PUT` to `/claude-config/skills/../../history.jsonl` → 403; a second test does the same through the planted `escape` junction | Both compare the target's sha256 before and after, not only the status. `fetch` collapses `../`, so the traversal case is sent verbatim over a socket |
| AC-2 | machine | `PUT` with no `if-match` → 400, file hash unchanged | Injection: dropping the precondition reddens this and AC-3, nothing else |
| AC-3 | machine | File rewritten from a second handle between read and save; stale-hash `PUT` → 409, other writer's bytes survive, response carries the current hash | A CONTROL in the same test saves successfully with the fresh hash — without it the suite would pass against a route that refuses every write |
| AC-4 | machine | `PUT` to `commands/invented.md` → 404 | `fs.existsSync` is asserted false afterwards; the absence is checked, not inferred from the status |
| AC-5 | machine | BOM + CRLF fixture read via `arrayBuffer`, `PUT` back, `Buffer.compare === 0`, plus byte 0 is `0xEF` and CRLF present | Injection: stripping the BOM on write reddens both byte-preservation tests. Compared as buffers, not strings |
| AC-6 | machine | 2 MB + 1 → 413 with hash unchanged; CONTROL sends 2 MB − 1 → 200, size asserted on disk | Without the control the cap could be zero and the rejection test would still pass |

## Findings

**AC-5 failed on its first run, and the defect was in the client, not the server.**

`Response.text()` performs a UTF-8 decode that strips a leading BOM (WHATWG fetch). The server had written exactly the bytes it was handed; the test lost them on the way in. A web client that reads with `.text()` and saves that string back would silently rewrite every BOM-carrying file — including `template-registry.json`, whose BOM has already broken `JSON.parse` in production once.

The test now reads via `arrayBuffer()`, and **a second test pins the hazard** so the web editor cannot be simplified into `.text()` later. TASK-1844 would have hit this for real.

**One injection was initially worthless and had to be redone.** The first attempt at the BOM injection produced TypeScript that did not compile, so vitest collected nothing and reported `Tests no tests`. That is not a pass — it is an absence of evidence that looks like evidence. It was rewritten, verified to compile, and only then trusted.

## Process failure in this iteration

**CI was configured and I merged before it finished.** `gh pr view --json statusCheckRollup` returned **3** checks with empty conclusions — queued, not complete — and §8.3 requires watching them to completion before merging. I merged anyway.

The outcome was benign: the same run completed on `main` as **success** on all three jobs, verified afterwards. The process error stands regardless, and it is recorded here rather than in a commit nobody re-reads. Earlier in this session I had asserted "this repo has no CI" — true of `choda-deck-companion`, false of `choda-deck`, and I carried the claim across the repo boundary without re-checking.

## Not done

Nothing. No criterion is human-class, no criterion is deferred.

## Blockers unblocked by this task

TASK-1842 (`POST /claude-config/validate`) was blocked by this task and is now eligible.
