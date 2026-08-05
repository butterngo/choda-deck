# TASK-1567 — AC verification

**Task:** Dispatcher: embed artifacts-relative capture paths, not absolute ones
**Verified:** 2026-08-05 · session SESSION-1785907899899-15 · merge commit `88f4fcf` (PR #240)
**Result: 8/8 verified · 0 needing a human · 0 blocked**

## Method

Every path-shape criterion was proven by POSTing real captures to the **built**
`dist/companion-server.cjs` (port 7398, `CHODA_DATA_DIR` pointed at a scratch **copy** of
the DB so the live one was never written), then reading the persisted entry bodies back
and extracting their markdown link targets. The unit tests ran separately as a gate.

## Per-criterion

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | `StoredArtifact.relPath` added alongside `filePath` | ✅ | all three writers return `relFrom(name)` via shared `CAPTURES_DIR` |
| 2 | image body → `![capture](captures/<hex>.png)` | ✅ | live: `captures/8b8d3cc68d314831.png`; no absolute target in any probe entry |
| 3 | element (`:151`) | ✅ | live: `![element](captures/b5644bead837974a.png)` |
| 4 | design (`:176`) | ✅ | live: `](captures/1dc99a916c5781bf.design.json)` |
| 5 | network-bundle (`:270`) | ✅ | live: `](captures/be028aca2e814613.har)` |
| 6 | discovery-session unchanged | ✅ | INBOX-1676 pointer still `captures/discovery-<hex>/timeline.jsonl` |
| 7 | file still lands under `<artifactsDir>/captures/` | ✅ | every `relPath` resolves to a real file on disk |
| 8 | `relPath` additive, callers still compile | ✅ | typecheck clean, 1592 tests pass, no caller changes |

## Findings

**1. The first version of these tests failed against correct code.**
`expect(body).not.toMatch(/[A-Za-z]:[\\/]/)` — intended to catch an absolute Windows path
— also matches the `http://` in the `Source:` line that every capture body carries. Five
red tests, zero defects. The assertion is now scoped to the markdown **link target**
(`/\]\(\s*[A-Za-z]:[\\/]/`).

The negative assertion is load-bearing and easy to get wrong in the other direction too: a
regression re-embedding the absolute path still satisfies a loose `captures/...` match,
because the absolute path *contains* that substring. Confirmed the test can fail by
reverting `dispatchImage` to `filePath` — exactly 2 tests went red — then restoring.

**2. `CHODA_DATA_DIR` does not isolate file-backed knowledge entries.**
The live probe pointed `CHODA_DATA_DIR` at a scratch dir, which correctly isolated the DB
and the artifacts. It did **not** isolate `knowledge_create`: the four probe entries were
written as real files into the repo's `docs/knowledge/` and mutated `INDEX.md`, because
knowledge entries resolve their path from the content root, not the data dir.

Cleaned up (files deleted, `INDEX.md` restored, tree verified clean). Filed as TASK-1572 —
anyone smoke-testing a capture against a scratch data dir will silently dirty the repo the
same way, and in an unattended run that state could be swept into a commit by a careless
`git add -A`.

## Gates

| Gate | Result |
|---|---|
| `pnpm run typecheck` | clean |
| `pnpm test` | 131 files / 1592 passed / 1 todo |
| `pnpm run lint` | clean |
| `pnpm run build:companion` + `build:mcp` | clean |
| CI (ubuntu + windows) | both pass |
| Merge proof | `88f4fcf` is an ancestor of `origin/main` |
