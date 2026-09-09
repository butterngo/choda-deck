---
task: TASK-1918
title: Walk the packaged app's way back out — TASK-1788 AC-7 and the human checks it was meant to be batched with
verified: 2026-09-09
session: SESSION-1788949914742-48
build: choda-companion-setup-0.12.5.exe (2026-09-09 17:22)
---

# AC verification — TASK-1918

**Done: 4/4. All four are human. Blockers: none.**

Every tick here rests on Butter's observation in the packaged window, in one
attended sitting, batched with TASK-1922. No test backs any of them, and that is
the point of the task: the packaged window has no address bar and no browser back
button (INBOX-1875), so "the breadcrumb computes the right destination" — which
TASK-1788's AC-3 and AC-4 already proved — is not the same claim as "a person can
find the way back".

## Criteria

| AC | Verdict | What Butter did |
|---|---|---|
| AC-1 | ✅ human | Workspace → Tasks tab → a task → back to that workspace's Tasks tab in **one** click; not Projects, not a different tab |
| AC-2 | ✅ human | Reached a task by a route carrying no origin; the crumb offered a destination that works and reads sensibly — no dead link, no empty label, no claimed origin the reader did not come from |
| AC-3 | ✅ human | Opened a commit in History and closed it with the panel's own control, without scrolling back to the row |
| AC-4 | ✅ human | Files tab: source and markdown in one tree, a `.ts` opens as text, a `.png` says why it will not open rather than rendering as noise |

## What this evidence is, and is not

It is one person's report, recorded as such in each `ac_check` string rather than
dressed up as a measurement. Nothing in CI will notice if any of these regress.
That is not a defect in the verification — it is the reason these four were split
out of TASK-1788 instead of being ticked off its green suite.

The honest limit: a human pass says the path exists and was findable **by the
person who built it**. It does not say a newcomer would find it.

## Carried

TASK-1788 AC-7 was the criterion this task exists to discharge, and it is now
discharged. TASK-1788 itself can move to DONE.

Its Related section also named TASK-1782 AC-5, TASK-1764 AC-6 and TASK-1786 AC-1
as possibly-unticked human checks to fold in. TASK-1786 has been DONE since
2026-09-03 — recorded here because an earlier report in this run claimed otherwise
twice, from inferring status out of a test comment rather than reading the record.
The other two were not re-examined in this sitting and are not claimed either way.
