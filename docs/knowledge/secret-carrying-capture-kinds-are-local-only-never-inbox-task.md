---
type: gotcha
title: Secret-carrying capture kinds are local-only (never inbox/task)
projectId: choda-deck
scope: project
refs:
  - path: src/adapters/companion/capture-dispatcher.ts
    commitSha: 79c7bb272eabead35f5c0661c95e50e9ba90046e
createdAt: 2026-07-13
lastVerifiedAt: 2026-07-13
affectedFeatureId: feature-companion-cockpit
---

## Trigger

Adding a new capture kind to the companion bridge, or widening an existing kind's allowed destinations.

## Context

The `POST /capture` bridge routes captures to inbox / task / conversation / knowledge. Under `CHODA_BACKEND=sync`, inbox and task writes ride the write-through loop to the remote (ADR-036). Network and image captures carry secrets — cookies, Authorization headers, response bodies, screenshots.

## Business rule

Any capture kind that can carry secrets (`network`, `network-bundle`, `image`) must only target `conversation` or `knowledge` (local-only). It must never be routable to `inbox` or `task`, or captured secrets can leak to the remote via sync.

## Resolution

`guardLocalOnly()` in `capture-dispatcher.ts` throws `CaptureBadRequestError` (bridge → 400) for inbox|task on these kinds. When adding a kind, call the guard unless the payload is provably secret-free. Established TASK-1332, extended to `network-bundle` in TASK-1372.
