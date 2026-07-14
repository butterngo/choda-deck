// TASK-1215 (epic TASK-1157 Sync Observatory) — the companion's read-only view of
// the durable sync_events log (TASK-1214). Feeds GET /sync/log → the SyncLog feed
// UI (TASK-1216).
//
// The core read is `listSyncEvents` (newest-first by monotonic id); this layer owns
// only the request policy: a default page size and a hard cap so a caller can never
// dump the whole retained window. Mirrors sync-ledger.ts — a thin, read-only compute
// fn over the db, no mutation.

import type Database from 'better-sqlite3'
import { listSyncEvents, type SyncEvent } from '../../core/sync/sync-events'

// Page-size policy for the endpoint. Default when the caller omits ?limit=; hard cap
// so an over-large or garbage limit still returns a bounded window.
export const DEFAULT_SYNC_LOG_LIMIT = 50
export const MAX_SYNC_LOG_LIMIT = 200

// Clamp a caller-supplied limit into [1, MAX]; NaN/undefined → default.
export function resolveSyncLogLimit(raw?: number): number {
  if (raw === undefined || isNaN(raw)) return DEFAULT_SYNC_LOG_LIMIT
  return Math.max(1, Math.min(Math.trunc(raw), MAX_SYNC_LOG_LIMIT))
}

// Read the sync activity log newest-first, honoring the default/cap policy.
export function computeSyncLog(db: Database.Database, limit?: number): SyncEvent[] {
  return listSyncEvents(db, resolveSyncLogLimit(limit))
}
