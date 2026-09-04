---
type: learning
title: Hold a task unapproved until its load-bearing assumption is measured
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-09-04
lastVerifiedAt: 2026-09-04
---

## What happened

TASK-1829's whole contract rested on one unproven reading: that `enabledMcpjsonServers` and `disabledMcpjsonServers` mean what their names say. Nobody had checked. Every acceptance criterion was falsifiable, named a surface, and had a single verdict — the criteria were fine.

They were also **useless as protection**, because every fixture behind them would have been written from the same assumption. If the reading were backwards, all eight would pass while the UI stated the opposite of the truth.

So the task was deliberately written, planned, ordered — and **not** approved for READY. READY means "authorised to run unattended", and unattended a runner would have built the fixtures from the guess and ticked every box.

## What the measurement changed

It took about ten minutes: a scratch project, two probe servers, `claude mcp list` run twice. The names turned out to be accurate — and the contract was still wrong twice over:

- **a third state existed.** A server in neither list is *pending*, and the planned `enabled: boolean` could not express it.
- **a disabled server disappears from the runtime**, so the inventory has to deliberately disagree with `claude mcp list` rather than match it.

Neither would have been caught by any test written against the assumption.

## The rule

**A criterion cannot protect you from a premise it inherits.** When a task's acceptance rests on how an external system behaves, the assumption is not a caveat to note in `## Assumptions` — it is a gate. Name it, refuse approval until it is measured, and write the fixtures afterwards.

The tell that this applies: ask "if this reading is backwards, which test goes red?" If the honest answer is *none*, no amount of AC quality helps.

## The cheap version

Most such assumptions are minutes to settle — a scratch directory, one CLI invocation, a diff. The reason they survive into code is not cost; it is that a plausible reading feels like knowledge. If the measurement needs to touch a real user config, copy it first and verify a byte-identical restore afterwards.

## Related

- TASK-1829 — the task that was held, and what the measurement changed
- `claude-code-mcp-config-has-three-states-and-the-runtime-hides-one-of-them` — the finding itself
- `/choda-plan` §6: an open question blocks approval; it does not become an AC
