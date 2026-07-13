---
type: gotcha
title: Capture bundle/export formats prefer the open standard (HAR 1.2)
projectId: choda-deck
scope: project
refs:
  - path: src/adapters/companion/capture-artifacts.ts
    commitSha: 79c7bb272eabead35f5c0661c95e50e9ba90046e
createdAt: 2026-07-13
lastVerifiedAt: 2026-07-13
affectedFeatureId: feature-companion-cockpit
---

## Trigger

Designing a new multi-item export or bundle artifact from the capture surface (network bundles, future log/console bundles, etc.).

## Context

TASK-1372 chose the bundle format for multi-request network captures: one artifact file linked from a single conversation/knowledge entry.

## Business rule

Prefer the established open format over a choda-specific JSON shape — the artifact must open in external tooling without a custom viewer.

## Resolution

Network bundles serialize as lean HAR 1.2 (`log.entries[]`, `-1` for unknown timings) via `buildHar()`/`writeHarArtifact()` in `capture-artifacts.ts`; the file imports directly into Chrome DevTools and any HAR viewer. Apply the same standard-first test to future bundle kinds.
