---
type: gotcha
title: Companion write-actions must confirm + surface result OR error — never silent
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-06-21
lastVerifiedAt: 2026-07-13
affectedFeatureId: feature-companion-cockpit
---

**Trigger:** adding any mutating action to a companion screen — Sync Pull/Push, mark-task-READY, start/end session, or any future write button.

**Context:** the companion exists to make state *trustworthy*. A mutation that silently no-ops (or appears to succeed when the endpoint is missing / sync isn't configured) reintroduces the exact "everything is in doubt" problem the tool fights. This is the write-side complement of the honest-liveness rule (see [[companion-screens-must-render-honest-liveness-never-fake-live]]).

**Business rule:** every mutating action must (1) **confirm before running** (it's not an idempotent read), and (2) surface the **real outcome** — the actual result on success, the actual error on failure — never a silent success.

**Resolution:** model actions as react-query `useMutation` with a `window.confirm` gate; render the success summary (`role="status"`) AND the error (`role="alert"`) from the mutation state; refetch the affected view on success. A 404 from an endpoint that doesn't exist yet (e.g. Pull/Push before TASK-1175) must show as an error, not a fake "done". Pattern reference: `packages/web/src/components/SyncActions.tsx` (TASK-1160).
