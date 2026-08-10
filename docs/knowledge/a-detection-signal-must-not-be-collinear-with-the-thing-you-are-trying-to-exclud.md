---
type: learning
title: A detection signal must not be collinear with the thing you are trying to exclude
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-08-08
lastVerifiedAt: 2026-08-08
---

## Trigger

You are writing a rule to classify inputs into two modes, and you reach for a
composite signal ("it's long AND it has many sections") to avoid the naive one.

## Context

`/choda-watch` needed to tell a course from a talk, so it could switch to a
module-index note instead of capping at 8 key points. INBOX-1696 proposed
detecting on `LONG_VIDEO` plus a high block count.

## The trap

Blocks are produced by `merge_blocks(lines, span=BLOCK_SECONDS)` — a fixed 75s
window. So block count is duration ÷ 75. A threshold on "many blocks" **is** a
threshold on duration, wearing a different name. The composite signal added no
information at all.

That matters because the control case is a long video that genuinely has a
thesis: the 104m Stanford lecture. Any duration-keyed rule flips it wrongly, and
the "many blocks" wrapper hides that it is duration-keyed.

## Business rule

Before trusting a composite or derived signal, check whether it is a
transformation of the variable you were trying to get away from. If signal B is
computed from signal A by a fixed factor, a threshold on B is a threshold on A.

## Resolution

Detected on **author-declared chapters** instead — genuinely independent of
duration — plus a size test, because chapter count alone flips a 19m tutorial
whose 10 chapters are sections of one argument rather than lessons.

Measured on four real videos:

| Video | Duration | Chapters | Each | Verdict |
|---|---|---|---|---|
| ML course (freeCodeCamp) | 233m | 25 | 9.3m | index |
| Stanford LLM lecture | 104m | 0 | — | thesis |
| BPMN tutorial | 19m | 10 | 1.9m | thesis |
| Cogover demo | 17m | 8 | 2.1m | thesis |

Rule: more chapters than the key-point cap (so the cap would discard something)
AND at least 5 minutes each (so they are lessons, not sections).

## Source

TASK-1586, from INBOX-1696. Implemented in `is_course_shaped()`.
