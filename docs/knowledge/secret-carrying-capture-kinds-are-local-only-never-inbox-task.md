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

The `POST /capture` bridge routes captures to inbox / task / conversation / knowledge. Under `CHODA_BACKEND=sync`, inbox and task writes ride the write-through loop to the remote (ADR-036), and conversations sync too since TASK-1136 (`openConversation` / `addConversationMessage` are wrapped by `sync-write-through.ts`). Only knowledge is off the write-through path. Network and image captures carry secrets — cookies, Authorization headers, response bodies, screenshots.

## Business rule

The destination is not the gate — a conversation message leaves the laptop as readily as an inbox row. Secret values must be removed **before anything is written**, for every destination: `redactNetworkRecord` (TASK-3155, called from `parseNetworkRecord`) masks credential header values, every cookie value and token-like body text; `credentialPageRule` (TASK-3156) refuses image / element-crop captures of known credential pages unless `payload.allowSensitive` is true. On top of that, any capture kind that can carry secrets (`network`, `network-bundle`, `image`, `element`, `design`) still only targets `conversation` or `knowledge`, never `inbox` or `task` — defence in depth, not the guarantee.

## Resolution

`guardLocalOnly()` in `capture-dispatcher.ts` throws `CaptureBadRequestError` (bridge → 400) for inbox|task on these kinds (TASK-1332, extended to `network-bundle` in TASK-1372). When adding a kind: route its payload through the redaction at parse time (or prove it secret-free), call `guardCredentialPage` before writing any image, and keep the local-only guard. Corrected 2026-11-10 (TASK-3158): the earlier text claimed conversations never sync, which stopped being true with TASK-1136.
