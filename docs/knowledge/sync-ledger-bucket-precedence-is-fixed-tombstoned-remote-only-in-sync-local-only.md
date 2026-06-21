---
type: gotcha
title: "Sync ledger bucket precedence is fixed: tombstoned > remote-only > in-sync > local-only"
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-06-20
lastVerifiedAt: 2026-06-20
affectedFeatureId: feature-companion-cockpit
---

**Trigger:** editing the companion sync-ledger classifier (`src/adapters/companion/sync-ledger.ts`) or adding a bucket.

**Context:** the ledger classifies every local row of a syncable table into one bucket from the three ADR-030 columns (`sync_origin`, `sync_updated_at`, `sync_deleted_at`). The buckets overlap by nature (a remote-origin row is also stamped), so order matters.

**Business rule:** each row must land in **exactly one** bucket, evaluated in this precedence: (1) tombstoned (`sync_deleted_at` not null) → (2) remote-only (`sync_origin='remote'`) → (3) in-sync (`sync_updated_at` not null) → (4) local-only (`sync_updated_at` null).

**Resolution:** encode the precedence as ordered `CASE` branches in one aggregate query per table; never independent COUNTs (they'd double-count). A new bucket = a new branch at the right precedence position, not an extra column.
