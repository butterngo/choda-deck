// TASK-1158 AC-2 — the sync ledger: per-entity counts of how each local row
// stands relative to the remote, derived purely from the three ADR-030 sync
// columns (sync_origin, sync_updated_at, sync_deleted_at). No remote round-trip.
//
// Bucket precedence (decided in TASK-1158, applied top-down so every row lands in
// exactly one bucket):
//   1. tombstoned  — sync_deleted_at IS NOT NULL (removed via sync)
//   2. remote-only — authored remotely (sync_origin = 'remote'), pulled to laptop
//   3. in-sync     — stamped by the clock (sync_updated_at IS NOT NULL)
//   4. local-only  — never stamped (sync_updated_at IS NULL): exists only here,
//                    not yet pushed (on-write-only sync leaves untouched rows cold)

import type Database from 'better-sqlite3'

// Entity types the companion surfaces. A subset of SYNCABLE_TABLES — the ledger
// shows what the user reasons about, not internal association tables.
export const LEDGER_ENTITIES: ReadonlyArray<{ entity: string; table: string }> = [
  { entity: 'tasks', table: 'tasks' },
  { entity: 'inbox', table: 'inbox_items' },
  { entity: 'conversations', table: 'conversations' },
  { entity: 'projects', table: 'projects' }
]

export interface LedgerRow {
  entity: string
  inSync: number
  localOnly: number
  remoteOnly: number
  tombstoned: number
}

// One aggregate query per table encodes the precedence above as ordered CASE
// branches. Tables are read from a fixed allowlist (LEDGER_ENTITIES) — never an
// caller-supplied identifier — so the interpolated name is safe.
export function computeLedger(db: Database.Database): LedgerRow[] {
  return LEDGER_ENTITIES.map(({ entity, table }) => {
    const row = db
      .prepare(
        `SELECT
           SUM(CASE WHEN sync_deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS tombstoned,
           SUM(CASE WHEN sync_deleted_at IS NULL AND sync_origin = 'remote' THEN 1 ELSE 0 END) AS remoteOnly,
           SUM(CASE WHEN sync_deleted_at IS NULL AND (sync_origin IS NULL OR sync_origin != 'remote')
                     AND sync_updated_at IS NOT NULL THEN 1 ELSE 0 END) AS inSync,
           SUM(CASE WHEN sync_deleted_at IS NULL AND (sync_origin IS NULL OR sync_origin != 'remote')
                     AND sync_updated_at IS NULL THEN 1 ELSE 0 END) AS localOnly
         FROM ${table}`
      )
      .get() as {
      tombstoned: number | null
      remoteOnly: number | null
      inSync: number | null
      localOnly: number | null
    }
    return {
      entity,
      inSync: row.inSync ?? 0,
      localOnly: row.localOnly ?? 0,
      remoteOnly: row.remoteOnly ?? 0,
      tombstoned: row.tombstoned ?? 0
    }
  })
}
