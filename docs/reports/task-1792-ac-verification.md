---
task: TASK-1792
title: From a task or a commit, land on the exact line that changed
verified: 2026-09-09
session: SESSION-1788943827031-23
note: verified retroactively — shipped in companion #82, mechanism later revised by TASK-1794
---

# AC verification — TASK-1792

**Done: 7/8. Needs a human: 1 (AC-8). Blockers: none.**
Held at IMPLEMENTED. Merge proven: `dab4735` (#82), an ancestor of `origin/main`.

Fresh run of the three files carrying these criteria: 51 tests, green.

## Criteria

| AC | Verdict | Evidence |
|---|---|---|
| AC-1 | ✅ | "distinguishes added, removed and context" + "carries the real file line numbers, **continuing across the hunk**" — the AC's fail is numbers restarting per hunk, and the test is named after it |
| AC-2 | ✅ | A two-link chain, both checked today — see below |
| AC-3 | ✅ | Property holds; mechanism superseded by TASK-1794 — see below |
| AC-4 | ✅ | Lines numbered from 1 with no phantom line from a trailing newline, `id="L3"`, every line in a set marked, **CONTROL** with nothing marked, and `lineFromHash` refusing seven malformed forms |
| AC-5 | ✅ | A binary row is a span not a button, and says "Not text — there are no lines to show", distinct from the empty-hunks sentence |
| AC-6 | ✅ | The `hunks === undefined` branch says the adapter does not serve diffs — neither an error nor an empty diff |
| AC-7 | ✅ | Cap message distinct from binary and from old-adapter — **with a caveat**, below |
| **AC-8** | **human** | **⬜ not done** — carried to TASK-1922 |

## AC-2 — proven as a chain, because no single surface holds it

The criterion says the *rendered* numbers match `git show`. Two links, each
checked at its own surface today:

1. **The adapter's numbers are git's.** Verified an hour ago for TASK-1791 AC-3:
   header `oldStart=77 oldLines=7 newStart=77 newLines=16` against `git show`'s
   `@@ -77,7 +77,16 @@`, with zero rows violating the add/del/ctx rule.
2. **The renderer does not renumber.** `FileDiff` prints the header straight from
   `h.oldStart/h.oldLines/h.newStart/h.newLines` and each line's number from the
   `DiffLine`, with a test asserting they continue across the hunk.

## AC-3 — the property holds; the mechanism was replaced, and the code says why

The AC describes clicking a row and *the file opening*. TASK-1794 changed how:
clicking no longer navigates to `/workspace-docs`, which is a top-level route
with no back control — and, as its own comment records, the obvious repair was a
breadcrumb, which is wrong, *because a commit touching 7 files would then cost 7
round trips through it*. The file opens in place, carrying the commit's other
changed files with it, so "back" is not a control that had to be found — it is a
trip that no longer happens.

What the AC asks for is what was checked: **not line 1, and not the wrong line.**
`CommitFileView` marks every changed line with a control asserting untouched lines
stay unmarked, and refuses to mark a line whose text no longer matches — saying
how many it could not place. That last property the AC never asked for and is the
difference between marking a line and marking the *right* line.

## AC-7 — passes as written, and the message over-fires

The three facts stay three sentences: binary, too-large, old-adapter. The
criterion holds.

**But** `FileDiff.tsx:110` reads `omitted === "binary" ? … : "Too large…"`, so
*any* null without a reason falls through to the cap message — and TASK-1791's
verification found that a **renamed** file returns exactly that: null, no reason.
So a renamed file is currently described to the reader as too large. Confidently,
and wrongly.

That is not this criterion's fault; it never imagined a third cause. Recorded
here and folded into **TASK-1921**, whose AC-4 requires every null to carry a
reason and whose AC-7 requires the fallback to stop claiming the cap.

## A correction to yesterday's prediction

Closing the previous iteration I wrote that a renamed file's row would be *a link
that opens nothing*. It is not: `openable` requires non-null hunks, so a renamed
row renders as plain text and there is no dead link. The real damage is narrower
and stranger — a path that names no file, shown beside a sentence claiming the
file is too large. Corrected in TASK-1921 rather than left to stand.

## Findings

`FileDiff.tsx:89` already renders `renamed from {file.oldPath}`. The consumer has
been ready for a proper `{ path, oldPath }` pair the whole time, and the adapter
has never sent one — so that affordance has never appeared for any commit in this
repo's history. TASK-1921's fix is filling a field someone already wrote the
reader for, which is a smaller job than it looked when the defect was first
described.
