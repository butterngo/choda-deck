# TASK-1842 — AC verification

**Adapter: checks are declared, never branched on — POST /claude-config/validate**

Run: `/choda-burn-backlog`, iteration 2 · 2026-09-04
Merged: PR #266, squash `096790f`, proven ancestor of `origin/main`
Gates: `typecheck` / `lint` / `build` exit 0, each run bare · `pnpm test` 1829 passed across 142 files (was 1814)
CI on PR #266: **watched to completion before merging** — `build-and-test (ubuntu)` pass 1m7s, `build-and-test (windows)` pass 1m48s, `docker-image` pass 1m7s

## Done — 5 of 5

| AC | Class | Proven by | Discriminator |
|---|---|---|---|
| AC-1 | machine | `POST /validate` → 200 with `findings` against a fixture HOME carrying no key; `fetch` stubbed to record every call, and the only recorded URL is the test's own request to the local port | A second test pins the premise: no `.claude.json` exists beside the fixture. Without it AC-1 could pass while proving something weaker than it claims |
| AC-2 | machine | A `SKILL.md` with the description line removed yields a `skill-frontmatter` finding naming that field | CONTROL: the same file **with** a description yields none. Without it the check could fire on every `SKILL.md` |
| AC-3 | machine | A raw-bytes BOM fixture yields `utf8-bom`, and `Buffer.compare` before/after is 0 with byte 0 still `0xEF` | CONTROL: a BOM-free file reports none. The byte comparison is what separates a validator from a formatter |
| AC-4 | machine | The test registers `invented-by-a-test` through `registerCheck` and its message and line arrive through the HTTP response; nothing in the runner names it. It unregisters and asserts it is gone | Injection: replacing the registry lookup with a `switch` on `rootId` reddens exactly these two tests. Verified to compile first |
| AC-5 | machine | `compareKeySets` returns one finding under `renderer-key-without-schema` and one under `schema-without-renderer`, each asserted by exact message, plus an explicit assertion that the ids differ | CONTROL: identical sets report nothing. Distinct ids are the criterion — one id for both would make the quiet failure indistinguishable from the loud one |

## Findings

**The extraction is the load-bearing part of this change, and its proof is that nothing moved.** The path resolution the file route used is now shared with the validate route rather than copied. All **52 existing route tests pass unchanged** — that is what makes it a refactor rather than a rewrite, and it is the same reasoning that put `PUT` through the `GET`'s allowlist in TASK-1841: a second copy of a boundary is how two paths drift until one serves what the other refuses.

**`compareKeySets` has no production consumer in this repo yet**, and that is stated rather than hidden. Its first is TASK-1384 in `juvenis-maxime`, where the loud direction (a renderer key with no schema) actually happened and the quiet direction (a schema nothing renders) has never been checked. Here it ships as the primitive that case needs, exercised through the public surface.

**A throwing check is reported, not fatal.** One broken declaration would otherwise silence every other check on the file — a failure mode that looks like "the file is clean".

## Process — corrected from iteration 1

Iteration 1 merged PR #264 while its three CI checks were still queued. This iteration waited: `gh pr checks 266 --watch` ran to completion and all three passed **before** the merge.

Worth recording, because it explains the earlier mistake: `statusCheckRollup` returned **0** immediately after the PR was created and **3** twenty seconds later. A single read right after `gh pr create` is not evidence that CI is absent — it is a race, and iteration 1 lost it silently.

## Not done

Nothing. No criterion is human-class, no criterion is deferred.

## Blockers unblocked by this task

TASK-1843 (`POST /claude-config/review`) and TASK-1844 (the web editor) were both blocked by this task. TASK-1843 is now eligible; TASK-1844 still waits on nothing else, so it becomes eligible too.
