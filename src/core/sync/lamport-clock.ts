// ADR-030 §Schema additions — Lamport-logical clock persisted in `_sync_clock`.
//
// A monotonic counter, NOT a wall-clock. Every synced write bumps it; the value
// stamped on a row's `updated_at` is what LWW reconciliation compares. Using a
// logical counter (not Date.now()) keeps ordering causally consistent on a
// single device and side-steps clock skew between devices.
//
// Phase 1 (TASK-978) ships this module + the `_sync_clock`/`_sync_state` tables
// but does NOT wire `tick()` into the service write paths yet — that is Phase 2.
// Created here so the table is present and the API is testable.

import type Database from 'better-sqlite3'

// Both singleton tables pin a single row at id = 0 via a CHECK constraint, so
// repeated INSERT OR IGNORE can never produce a second row.
export function createSyncClockTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _sync_clock (
      id INTEGER PRIMARY KEY CHECK (id = 0),
      counter INTEGER NOT NULL DEFAULT 0
    )
  `)
  db.exec('INSERT OR IGNORE INTO _sync_clock (id, counter) VALUES (0, 0)')
  db.exec(`
    CREATE TABLE IF NOT EXISTS _sync_state (
      id INTEGER PRIMARY KEY CHECK (id = 0),
      last_pull_at INTEGER NOT NULL DEFAULT 0
    )
  `)
  db.exec('INSERT OR IGNORE INTO _sync_state (id, last_pull_at) VALUES (0, 0)')
}

// Atomically increment the counter and return the new value. UPDATE ... RETURNING
// is a single statement, so concurrent better-sqlite3 callers on one connection
// can't interleave and hand out a duplicate tick.
export function tick(db: Database.Database): number {
  const row = db
    .prepare('UPDATE _sync_clock SET counter = counter + 1 WHERE id = 0 RETURNING counter')
    .get() as { counter: number } | undefined
  if (!row) {
    throw new Error('_sync_clock not initialized — call createSyncClockTables first')
  }
  return row.counter
}

// Lamport merge on receive: advance the local counter to at least `value` so any
// subsequent local write is stamped higher than anything just pulled from a
// remote clock. Without this, the local and remote counters are independent and
// a later local edit could be assigned a value below a pulled row's, losing LWW.
export function mergeClock(db: Database.Database, value: number): void {
  db.prepare('UPDATE _sync_clock SET counter = MAX(counter, ?) WHERE id = 0').run(value)
}

// Read the current counter without advancing it.
export function peek(db: Database.Database): number {
  const row = db.prepare('SELECT counter FROM _sync_clock WHERE id = 0').get() as
    | { counter: number }
    | undefined
  return row?.counter ?? 0
}

// Last successful pull cursor (Phase 2 read-only pull bumps this).
export function getLastPullAt(db: Database.Database): number {
  const row = db.prepare('SELECT last_pull_at FROM _sync_state WHERE id = 0').get() as
    | { last_pull_at: number }
    | undefined
  return row?.last_pull_at ?? 0
}

export function setLastPullAt(db: Database.Database, value: number): void {
  db.prepare('UPDATE _sync_state SET last_pull_at = ? WHERE id = 0').run(value)
}
