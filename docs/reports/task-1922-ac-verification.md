---
task: TASK-1922
title: Land on the changed line in the packaged app — TASK-1792 AC-8
verified: 2026-09-09
session: SESSION-1788949914742-48
build: choda-companion-setup-0.12.5.exe (2026-09-09 17:22)
---

# AC verification — TASK-1922

**Done: 4/4. All four are human. Blockers: none.**

## The build had to be made before the check could mean anything

AC-3 asks about behaviour that shipped this morning, and the vendored adapter lags
a release (INBOX-1888). Checked before the sitting rather than assumed:

```
resources/adapter/companion-server.cjs   "--numstat", "-z", "-M"   capBytes   no-patch
packages/web/dist/assets/index-*.js      "could not be read for this file"
```

Both halves of TASK-1921 are inside the packaged artifact. On the 0.12.4 build
they were absent — `capBytes:0  no-patch:0` — so the same eight clicks a day
earlier would have been answering a question about last week's code while looking
like a clean pass.

## Criteria

| AC | Verdict | What Butter did |
|---|---|---|
| AC-1 | ✅ human | Opened a commit with several changed files, clicked one, landed on a changed line with it marked — not the top of the file |
| AC-2 | ✅ human | Moved to another of that commit's changed files without going back, so TASK-1794's removed round trip stays removed |
| AC-3 | ✅ human | Commit `d07ce1b`, three renames: real paths, no `{`, no `=>`, "renamed from …" present, rows open to their diff, nothing claiming too large |
| AC-4 | ✅ human | A drifted file reported how many marks it could not place rather than marking confidently |

## AC-3 was rewritten the same day it was verified

As drafted that morning it asked Butter to **confirm** a renamed file reads "Too
large to show line by line" — a false sentence the reader was being shown, and at
the time a true description of the app. TASK-1921 landed that afternoon. Run
unchanged, AC-3 would have failed for the one reason that is good news: the defect
no longer reproduces.

It was rewritten while the body was still editable (the body locks at IN-PROGRESS)
to ask the opposite question, and the rewrite plus its reason is recorded in the
task body rather than only here.

Worth keeping: **a criterion written against a known defect has a shelf life.** It
is a good criterion — it costs one commit to look at and it grounds the bug report
from the reader's side — but it expires the moment the fix lands, and nothing
warns you. The AC and the fix were roughly six hours apart.

## AC-4 is the one that could have passed while failing

Its failure mode — confident marks on a drifted file — looks identical to a pass
unless the reader checks whether the marked lines are the ones that changed. It
was called out before the sitting for that reason, and Butter reports the pane
stated its uncompleted marks rather than guessing.

## Carried

TASK-1792 AC-8 is discharged; TASK-1792 can move to DONE. This is also the
reader-side confirmation of TASK-1921, whose seven machine criteria were verified
earlier the same day (`docs/reports/task-1921-ac-verification.md`).
