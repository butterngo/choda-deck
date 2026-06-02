---
type: gotcha
title: "Gotcha: tester guards must not reject verbatim AC"
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-06-02
lastVerifiedAt: 2026-06-02
affectedFeatureId: feature-readtime-role-projection
---

## Trigger

Tightening the tester role's M3 guards (symbol-bleed / deployment-date).

## Context

AC items are the tester's *source material*, not a derived surface. A symbol or date the task author wrote into their own AC is faithful relay, not cross-role bleed — a blanket ban wrongly rejects it. `assertNoDeploymentDate` is deliberately narrow: an ISO date trips it only when adjacent to a deploy/ship/release verb, so a diagnostic date like "data inspection on dev DB (2026-05-22)" survives.

## Resolution

Scope tester guards to DERIVED surfaces only — edge cases, regression scope, task titles. Never run them over verbatim AC items.
