---
type: gotcha
title: "Gotcha: role guards operate on rendered output, not fields"
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-06-02
lastVerifiedAt: 2026-06-02
affectedFeatureId: feature-readtime-role-projection
---

## Trigger

Adding a new role, or a new derived surface to an existing role, in `feature_projection`.

## Context

The M3/M4 guards (`assertNoCodeBleed`, `assertNoNumberOfDays`, `assertNoSymbolBleed`, `assertNoDeploymentDate`) run over the *projected strings* as a structural backstop — they are NOT field-level filters baked into the type. A newly added derived surface (a new edge-case string, a new title list) is only checked if it is explicitly passed into the role's `assert*` call. Miss it and dev symbols or a day-count can bleed through unguarded.

## Resolution

When you add a derived surface to a role view, add it to that role's guard argument list in `projectFeature`. The guard is the backstop; the type system will not catch the omission.
