// TASK-1214 (ADR-030, epic TASK-1157 Sync Observatory) — durable sync activity log.
//
// The sync engine (CHODA_BACKEND=sync) otherwise keeps only end-state: the Lamport
// cursor, per-row sync_updated_at/_deleted_at/_origin, aggregate ledger counts, and
// the _sync_state heartbeat. None of that says "a pull ran at T and upserted N", so
// a chronological activity feed (the user-requested SyncLog screen, fed by the next
// task's GET /sync/log) has no data source. This append-only table is that source.
//
// - `at` is WALL-CLOCK epoch ms — the feed shows real time, not Lamport order.
// - SQLite-only (the laptop is the working copy); deliberately NOT in
//   SYNCABLE_TABLES, so it is never pushed/pulled.
// - Capped append-only: each insert prunes the oldest rows past the retention cap,
//   mirroring the CHODA_TOMBSTONE_TTL_DAYS-style env override. AUTOINCREMENT ids are
//   monotonic + never reused, so "newest N by id" is a stable FIFO window.

import type Database from 'better-sqlite3'
import type { PullCounts } from './sync-pull'

export type SyncEventKind = 'pull' | 'push' | 'drain' | 'conflict'

export interface SyncEvent {
  id: number
  at: number // epoch ms, wall-clock
  kind: SyncEventKind
  upserted: number
  tombstoned: number
  pushed: number
  conflicts: number
  note: string | null
}

export interface AppendSyncEvent {
  at: number
  kind: SyncEventKind
  upserted?: number
  tombstoned?: number
  pushed?: number
  conflicts?: number
  note?: string | null
}

// Retention cap — newest N events are kept; older ones are pruned on append.
export const DEFAULT_SYNC_EVENTS_CAP = 500

// Resolve the cap from the env (CHODA_SYNC_EVENTS_CAP), falling back to the default.
// A non-positive or unparseable value falls back rather than disabling retention.
export function syncEventsCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CHODA_SYNC_EVENTS_CAP
  const n = raw ? parseInt(raw, 10) : NaN
  return !isNaN(n) && n > 0 ? n : DEFAULT_SYNC_EVENTS_CAP
}

export function createSyncEventsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('pull','push','drain','conflict')),
      upserted INTEGER NOT NULL DEFAULT 0,
      tombstoned INTEGER NOT NULL DEFAULT 0,
      pushed INTEGER NOT NULL DEFAULT 0,
      conflicts INTEGER NOT NULL DEFAULT 0,
      note TEXT
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_sync_events_at ON sync_events(at)')
}

// Append one event, then enforce the retention cap. Returns the new row id.
export function appendSyncEvent(
  db: Database.Database,
  e: AppendSyncEvent,
  cap: number = syncEventsCap()
): number {
  const info = db
    .prepare(
      `INSERT INTO sync_events (at, kind, upserted, tombstoned, pushed, conflicts, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(e.at, e.kind, e.upserted ?? 0, e.tombstoned ?? 0, e.pushed ?? 0, e.conflicts ?? 0, e.note ?? null)
  pruneSyncEvents(db, cap)
  return Number(info.lastInsertRowid)
}

// Delete everything but the newest `cap` rows (by id). Returns rows pruned.
export function pruneSyncEvents(db: Database.Database, cap: number = syncEventsCap()): number {
  const info = db
    .prepare(
      `DELETE FROM sync_events
       WHERE id NOT IN (SELECT id FROM sync_events ORDER BY id DESC LIMIT ?)`
    )
    .run(cap)
  return info.changes
}

// Read events newest-first (the feed order). Optional limit for paged reads.
export function listSyncEvents(db: Database.Database, limit?: number): SyncEvent[] {
  const sql = `SELECT id, at, kind, upserted, tombstoned, pushed, conflicts, note
               FROM sync_events ORDER BY id DESC${limit ? ' LIMIT ?' : ''}`
  const stmt = db.prepare(sql)
  return (limit ? stmt.all(limit) : stmt.all()) as SyncEvent[]
}

// Sum one count field across a pull's per-table breakdown.
export function sumPullCounts(counts: PullCounts[], key: 'upserted' | 'tombstoned'): number {
  return counts.reduce((acc, c) => acc + c[key], 0)
}
