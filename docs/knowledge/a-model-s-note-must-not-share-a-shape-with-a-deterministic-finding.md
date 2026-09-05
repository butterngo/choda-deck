---
type: gotcha
title: A model's note must not share a shape with a deterministic finding
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-09-05
lastVerifiedAt: 2026-09-05
affectedFeatureId: feature-companion-ui
---

**Trigger:** you are about to merge `ReviewNote` into `ConfigFinding` — one type, one renderer, a `source: 'check' | 'model'` field to tell them apart. It is less code and it reads as tidier.

**Context.** The Setup pane shows two kinds of statement about a config file. A **finding** comes from a deterministic check: a missing frontmatter field is missing, and the checker cannot be wrong about it. A **note** comes from a model asked to judge prose — whether a description says *when* to trigger, whether two entries duplicate each other. It can be confidently, fluently incorrect.

**The rule.** Sharing the shape means sharing the renderer, and sharing the renderer is how a wrong judgement **inherits a check's authority** in the reader's eye. The two must remain distinguishable in the DOM, not merely in a field nobody renders.

**Resolution (TASK-1845).** Separate types, separate containers, and a label that says what it is — *"From the model — judgement, not a check"*. The acceptance criterion asserts it structurally: `setup-review-notes` does not contain `setup-findings`, each item is resolved via `within()` its own block. A refactor that merges the lists fails rather than passing quietly.

**Why a comment would not have been enough.** The tempting design is cheaper on every axis a reviewer measures — fewer lines, fewer types, one code path. Nothing about the merged version looks wrong; it looks better. Only a test that asserts the *separation* survives the next person who finds it tidier.

**Related.** The same instinct produced the cost boundary two routes over: `/validate` is free and `/review` is paid, and they are separate routes rather than one route with a flag, so "no model call without a click" is structural rather than a convention someone has to remember.
