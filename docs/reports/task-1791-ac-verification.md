---
task: TASK-1791
title: Commit detail can say which LINES changed, not just how many
verified: 2026-09-09
session: SESSION-1788943286490-12
note: verified retroactively — shipped in #259; two criteria failed and are now TASK-1921
---

# AC verification — TASK-1791

**Done: 5/7. Failed: 2 (AC-5, AC-6). Needs a human: none.**
Held at IMPLEMENTED. The merge is proven — `aa08ad9` (#259) is an ancestor of
`origin/main` — but two criteria do not hold, and an unticked AC blocks DONE
whether the reason is a missing check or a real defect.

Everything below was measured against the **live adapter**, not the test suite.

## Criteria

| AC | Verdict | Evidence |
|---|---|---|
| AC-1 | ✅ | Commit `4d7034b`: hunk line counts equal the stat exactly — 12/12 add and 3/3 del on one file, 82/82 and 0/0 on the other. Cross-checked against git's counts, not the parser's |
| AC-2 | ✅ | Without `patch=1`: zero occurrences of `hunks` (1,782 B vs 12,043 B), top-level fields identical, file entries identical once `hunks` is dropped |
| AC-3 | ✅ | Header came back `oldStart=77 oldLines=7 newStart=77 newLines=16`; `git show` prints `@@ -77,7 +77,16 @@`. Zero rows violate the add/del/ctx numbering rule |
| AC-4 | ✅ | Commit `c5a0e76`: three binaries → `null`; **control** — `icon.svg` and `build-icons.mjs` → non-empty arrays; zero entries with `[]` |
| **AC-5** | ❌ | `hunks: null` and `omitted: 'too-large'` are right, but **the cap value is not in the response** |
| **AC-6** | ❌ | The parser survives a rename, but the path is unusable and the diff is dropped |
| AC-7 | ✅ | Three paired runs: +27 ms, +38 ms, −36 ms. Under 300 ms, and under the noise floor |

## AC-6 — the parser does not crash, and that was never the hard part

Commit `d07ce1b` renames three files. The response:

```
src/adapters/mcp/rules/{session-rules-loader.ts => mcp-rules-loader.ts}
  ins=14 del=10  hunks=null  omitted=(absent)
```

Two things wrong, and the AC only anticipated a third that did not happen.

**The path names no file.** It is git's `--stat` compact form — a display
convention — parsed as data. The real path, `…/rules/mcp-rules-loader.ts`, exists
on disk, and `git show --name-status -M` already reports the pair cleanly as
`R071 <old> <new>`. The criterion asks for "the file under its new path"; this is
neither path.

**The diff is dropped.** `hunks: null` on a text file with 14 additions and 10
deletions. Under this module's own contract `null` means *not produced* — binary
or over the cap — and neither holds. `omitted` is absent, so a renamed file is
indistinguishable from a binary one.

The AC's stated fail conditions were "an exception, or a phantom whole-file
rewrite". Neither occurred, and the criterion still fails: it asked for a
property, and the property is absent. Ticking it because the listed failures did
not fire would be reading the fail-list as the whole criterion.

## AC-5 — the reason is there, the number is not

An over-cap file (`pnpm-lock.yaml` in `9d776c6`, 969/7619 lines) returns
`hunks: null` with `omitted: 'too-large'`. That is better than the AC asked for in
one respect — the reason is machine-readable — and short in the one it named:
*"states the cap in the response"*. The cap lives at `commit-diff.ts:59` as
`MAX_FILE_PATCH_BYTES = 256 * 1024` and never travels. A client that wants to say
"skipped, over 256 KB" has to hardcode 262144 and hope it stays true.

## What this costs downstream

TASK-1792 — next in this run — makes a changed-file row a **link** to the file at
its first changed line. A row carrying `{old => new}` opens nothing. Its AC-3
cannot honestly hold for a renamed file until AC-1 of the follow-up does.

## Carried forward

**TASK-1921** — one task, three criteria's worth of defect: the rename path, the
dropped hunks with no `omitted` reason, and the unstated cap. Its AC-1 must be
written first and watched to fail against today's adapter; `d07ce1b` is the live
reproduction.

## Findings

This is the first of the retroactively-verified records where verification
**found something** rather than confirming it. The four closed this morning were
all sound. That is worth noting in both directions: the exercise is not a
formality, and four clean results in a row are not evidence that the fifth will
be.
