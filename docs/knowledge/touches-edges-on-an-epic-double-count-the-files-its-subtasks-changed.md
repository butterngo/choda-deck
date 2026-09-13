---
type: gotcha
title: TOUCHES edges on an epic double-count the files its subtasks changed
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-09-12
lastVerifiedAt: 2026-09-12
affectedFeatureId: feature-knowledge-graph
---

**Trigger:** you are closing an epic-shaped task — one whose actual code landed in commits made under its subtasks — and `session_end` reports zero derived `modifies` edges, so you reach for `touches_add` to "fix" the gap.

## Context

`session_end` auto-derives one `modifies` TOUCHES edge per distinct `file_modified` event of the session (ADR-029 channel 1). When the edit hook is not installed on the machine, the session records no such events and the derivation produces nothing. The documented fallback is to record `modifies` by hand from the git diff changed-file set.

That fallback is correct for a leaf task. **It is wrong for an epic**, and the wrongness is not obvious, because the epic's session really does span the commits in question.

## Business rule

- **`modifies` belongs to the subtask that changed the file.** The parent gains nothing true by repeating it — the graph then shows two tasks modifying the same anchor, and a later feature projection or audit reads one change as two.
- **`reference` must not name files the task itself produced.** A reference edge asserts "this task read this code to understand a contract it did not write". Pointing it at the epic's own output inverts that meaning.

An epic whose subtasks are all properly edged needs **no TOUCHES edges of its own**. Zero is the correct number, not a gap to be filled.

## Resolution

At `session_end` on an epic:

1. Let `modifies` derive to nothing, and say so explicitly in the summary rather than silently writing edges.
2. Check whether the commits are already owned: if the code landed as `TASK-child`, that child's own session carries the edges.
3. Write `reference` edges only for code genuinely read-not-written — which for an epic is usually nothing, since the code under review is its own deliverable.

## Worked example

TASK-1931 (mermaid fence editing, 7 subtasks). Its session showed zero `file_modified` events, and the seven files in commit `96a7126` were the output of subtask TASK-1937. Writing them onto TASK-1931 would have double-counted every one. Every file read during its acceptance verification — `mermaid-check.ts`, `workspace-docs.ts`, `FenceEditor.tsx`, `api.ts` — was likewise the epic's own product, so no `reference` edge was honest either. The session closed with zero TOUCHES, deliberately and on the record.
