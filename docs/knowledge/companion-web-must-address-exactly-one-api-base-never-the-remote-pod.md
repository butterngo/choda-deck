---
type: gotcha
title: Companion web must address exactly ONE API base — never the remote pod
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-06-21
lastVerifiedAt: 2026-06-21
affectedFeatureId: feature-companion-cockpit
---

**Trigger:** adding any fetch / data call anywhere in `packages/web`.

**Context:** the companion web client is built on a single-source-of-truth contract — the laptop is canonical and the laptop's own sync engine owns laptop↔remote. The browser must never talk to the remote pod (`mcp.choda.dev`) or hold an OAuth credential.

**Business rule:** all data access goes through `API_BASE = '/api'` (config.ts), which the Vite dev proxy forwards to the laptop adapter at `127.0.0.1:7338`. No remote/OAuth URL may appear in web source.

**Resolution:** use the `api.ts` client (built on `API_BASE`); never hardcode a host. The `single-api.test.ts` guard fails the build if any web src file contains a real remote pod URL, and asserts `API_BASE` stays a same-origin relative path. New pillar screens (Observatory/Cockpit/Knowledge) add endpoints under this same base, never a second origin.
