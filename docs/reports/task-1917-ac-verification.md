---
task: TASK-1917
title: Drive the four human criteria of TASK-1915 — the skills calling the grader for real
verified: 2026-09-09
session: SESSION-1788950448782-71
---

# AC verification — TASK-1917

**Done: 3/4. Not done: 1 (AC-1). Blockers: none — AC-1 needs an occasion, not a fix.**
Held at IMPLEMENTED. An unticked criterion blocks DONE whether the cause is a defect or
a missing opportunity.

## Criteria

| AC | Verdict | Evidence |
|---|---|---|
| **AC-1** | ⬜ **not done** | Needs a real `/choda-plan` run over a subtask carrying a vague criterion — see below |
| AC-2 | ✅ | CONTROL: `ac_review` on TASK-1921, 7 criteria all naming their surface → **7/7 `ok`**, every concern null |
| AC-3 | ✅ | **3 calls, 15 criteria, 3 tasks** — 1920 (4), 1921 (7), 1917 (4). One per task, never one per criterion |
| AC-4 | ✅ | `ai-provider.json` moved aside → `NO_MODEL_CONFIGURED` with a message naming the cause; restored after |

## Why AC-1 is left unticked

Its first half is satisfied and then some: three tasks graded live, and the grader
returned `weak` with a stated concern on real criteria — TASK-1920 AC-2, and all four of
TASK-1917's own. Nothing was withheld from approval as a result.

Its second half is not: the criterion says **run `/choda-plan`** on a parent whose
subtask carries a deliberately vague criterion, and observe the task still offered in the
approval question. There is no such parent in the backlog right now. Manufacturing one —
creating a throwaway task whose AC says "handles errors properly" so the check has
something to bite — would be writing the answer and then reading it back.

So it waits for a real planning occasion. That is a scheduling fact, not a defect, and it
costs nothing to leave honest.

## What AC-2's control actually established

The two runs are worth putting side by side, because the pair is the whole point:

| Task | Criteria | Verdicts |
|---|---|---|
| TASK-1921 | 7 | **7 `ok`**, nothing flagged |
| TASK-1917 | 4 | **4 `weak`**, all on the same ground |
| TASK-1920 | 4 | 3 `ok`, 1 `weak` |

A grader stuck on `weak` cannot produce the first row, and a grader stuck on `ok` cannot
produce the second. Both failure modes are excluded by data from one sitting.

## A finding for TASK-1920, not for this task

All four of TASK-1917's own criteria came back `weak` with the same concern — *"does not
specify where to observe"* — including AC-4, which says in as many words: rename
`ai-provider.json` aside, and both skills say the grader is unavailable in one line. That
names a file, an action, and the sentence to look for. The concern does not hold.

This is the over-flagging shape TASK-1916 recorded on TASK-1105, seen a second time. Two
of the three gradings TASK-1920 is waiting for are now on record. It stays TODO until the
third; a fix designed against two observations is what its AC-2 exists to prevent.

It is also, quietly, the argument for TASK-1915's advisory-not-blocking decision holding
up. A blocking grader would have withheld this task from approval on four concerns, three
of which a person disagrees with.

## Findings

The grader is at its most confident about the criteria it understands least. Its `ok`
rows on TASK-1921 were about renamed paths, byte counts and rendered sentences —
concrete things. Its `weak` rows here are about a **human procedure**, where "the
surface" is a terminal Butter is looking at, and it asked for that to be named as though
it were an API field. The five tests were written for criteria a machine can check, and
the grader appears to apply them as if every criterion were one.
