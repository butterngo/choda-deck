// ADR-030 Phase 2 (TASK-978) — the SOURCE side of read-only pull. Given a
// Lamport cursor, return every syncable row changed since it (live or tombstoned)
// in canonical row shape. The remote (Postgres, behind GET /sync/since) is the
// real producer; the SQLite variant exists for parity, local-source tests, and a
// future SQLite-to-SQLite pull. Both return the same TableDelta[] the reconcile
// core (sync-pull.ts) consumes.
//
// "Changed since cursor" = sync_updated_at > since OR sync_deleted_at > since.
// In practice only inbox_items carries a non-NULL sync_updated_at today (it is
// the lone remote-writable table — inbox_add), so the other syncable tables come
// back empty until the remote write surface widens.
//
// The WRITE side (applyDelta*, POST /sync/apply) is the symmetric sink — see
// sync-sink.ts.

import type Database from 'better-sqlite3'
import type { PgConnection } from '../domain/repositories/postgres/connection'
import { SYNCABLE_TABLES } from './syncable-tables'
import type { PulledRow, TableDelta } from './sync-pull'

export function fetchSinceFromSqlite(db: Database.Database, since: number): TableDelta[] {
  const deltas: TableDelta[] = []
  for (const table of SYNCABLE_TABLES) {
    const rows = db
      .prepare(
        `SELECT * FROM ${table} WHERE sync_updated_at > ? OR sync_deleted_at > ? ORDER BY sync_updated_at`
      )
      .all(since, since) as PulledRow[]
    if (rows.length > 0) deltas.push({ table, rows })
  }
  return deltas
}

export async function fetchSinceFromPg(conn: PgConnection, since: number): Promise<TableDelta[]> {
  const deltas: TableDelta[] = []
  for (const table of SYNCABLE_TABLES) {
    const result = await conn.query(
      `SELECT * FROM ${table} WHERE sync_updated_at > $1 OR sync_deleted_at > $1 ORDER BY sync_updated_at`,
      [since]
    )
    if (result.rows.length > 0) {
      deltas.push({ table, rows: result.rows.map(normalizePgRow) })
    }
  }
  return deltas
}

// node-pg quirks to flatten before the row crosses the wire / lands in SQLite:
// - BIGINT (sync_updated_at / sync_deleted_at) comes back as a string → Number.
// - TIMESTAMPTZ comes back as a Date → ISO string (SQLite stores text dates).
// Other columns (TEXT, JSONB→array/object, BOOLEAN) pass through; the SQLite
// upsert's normalizeValue handles bool/object on insert.
function normalizePgRow(row: Record<string, unknown>): PulledRow {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    if (k === 'sync_updated_at' || k === 'sync_deleted_at') {
      out[k] = v === null || v === undefined ? null : Number(v)
    } else if (v instanceof Date) {
      out[k] = v.toISOString()
    } else {
      out[k] = v
    }
  }
  return out as PulledRow
}
