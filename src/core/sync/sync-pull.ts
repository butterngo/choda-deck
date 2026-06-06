// ADR-030 Phase 2 (TASK-978) — read-only pull: remote → local SQLite.
//
// Catches the "mobile/web wrote to remote Postgres, desktop needs to see it"
// divergence. NO write-through (that's parked Phases 3-6). The reconcile core
// here depends only on the `PullSource` port, so it is fully testable with a
// fake in-memory source — the PG-backed source + the `GET /sync/since` endpoint
// that feeds it are separate slices.
//
// Conflict rule (ADR-030 §Conflict rule, the read side): per-row LWW on the
// Lamport `updated_at`. If the local row's `updated_at` is >= the remote's, the
// local copy wins and the remote row is skipped. Otherwise the remote row wins:
// a tombstone (`deleted_at` set) deletes the local row, a live row upserts.

import type Database from 'better-sqlite3'
import { SYNCABLE_TABLES } from './syncable-tables'
import { getLastPullAt, setLastPullAt } from './lamport-clock'

export interface PulledRow {
  id: string
  sync_updated_at: number
  sync_deleted_at: number | null
  [column: string]: unknown
}

export interface TableDelta {
  table: string
  rows: PulledRow[]
}

// A source of canonical rows changed since a Lamport cursor. Phase 2's concrete
// implementation (Postgres-backed, behind `GET /sync/since`) is a later slice;
// the reconcile core depends only on this port.
export interface PullSource {
  fetchSince(since: number): Promise<TableDelta[]>
}

export interface PullCounts {
  table: string
  upserted: number
  tombstoned: number
  skipped: number
}

export interface PullResult {
  since: number
  newCursor: number
  counts: PullCounts[]
}

type Plan = 'skip' | 'delete' | 'upsert'

// Fetch deltas since the stored cursor, apply them under per-row LWW inside one
// transaction, then advance `last_pull_at` to the highest Lamport value seen.
// Deletes run child→parent and upserts parent→child so FK constraints hold
// regardless of whether PRAGMA foreign_keys is on.
export async function pull(db: Database.Database, source: PullSource): Promise<PullResult> {
  const since = getLastPullAt(db)
  const deltas = await source.fetchSince(since)

  const byTable = new Map<string, PulledRow[]>()
  for (const delta of deltas) {
    // Ignore tables outside the syncable set — the source should never send them,
    // but a stray table would otherwise hit an arbitrary SQL identifier.
    if (SYNCABLE_TABLES.includes(delta.table)) byTable.set(delta.table, delta.rows)
  }

  const counts = new Map<string, PullCounts>()
  for (const table of SYNCABLE_TABLES) {
    counts.set(table, { table, upserted: 0, tombstoned: 0, skipped: 0 })
  }

  let maxCursor = since

  const apply = db.transaction(() => {
    // Resolve each row's plan first so the delete/upsert passes don't re-query.
    const planned = new Map<string, Array<{ row: PulledRow; plan: Plan }>>()
    for (const table of SYNCABLE_TABLES) {
      const rows = byTable.get(table) ?? []
      const resolved = rows.map((row) => ({ row, plan: planRow(db, table, row) }))
      planned.set(table, resolved)
      const c = counts.get(table)!
      for (const { row, plan } of resolved) {
        if (plan === 'skip') c.skipped++
        maxCursor = Math.max(maxCursor, row.sync_updated_at, row.sync_deleted_at ?? 0)
      }
    }

    // Pass 1: deletes, child → parent.
    for (const table of [...SYNCABLE_TABLES].reverse()) {
      for (const { row, plan } of planned.get(table)!) {
        if (plan !== 'delete') continue
        db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(row.id)
        counts.get(table)!.tombstoned++
      }
    }

    // Pass 2: upserts, parent → child.
    for (const table of SYNCABLE_TABLES) {
      for (const { row, plan } of planned.get(table)!) {
        if (plan !== 'upsert') continue
        upsertRow(db, table, row)
        counts.get(table)!.upserted++
      }
    }
  })
  apply()

  if (maxCursor > since) setLastPullAt(db, maxCursor)

  return { since, newCursor: maxCursor, counts: [...counts.values()] }
}

// LWW decision for one remote row. A local row with a NULL `updated_at` (e.g. a
// pre-Phase-2 row never stamped by the clock) always loses to a stamped remote
// row, so the remote wins.
function planRow(db: Database.Database, table: string, row: PulledRow): Plan {
  const local = db.prepare(`SELECT sync_updated_at FROM ${table} WHERE id = ?`).get(row.id) as
    | { sync_updated_at: number | null }
    | undefined
  if (local && local.sync_updated_at !== null && local.sync_updated_at >= row.sync_updated_at) {
    return 'skip'
  }
  return row.sync_deleted_at !== null && row.sync_deleted_at !== undefined ? 'delete' : 'upsert'
}

// INSERT … ON CONFLICT(id) DO UPDATE, intersecting the row's keys with the
// target table's real columns (same drift-resilience as the import-service).
function upsertRow(db: Database.Database, table: string, row: PulledRow): void {
  const targetCols = new Set(tableColumns(db, table))
  const cols = Object.keys(row)
    .filter((k) => targetCols.has(k))
    .sort()
  if (cols.length === 0) return
  const placeholders = cols.map(() => '?').join(',')
  const updates = cols.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`)
  const sql =
    updates.length > 0
      ? `INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})
         ON CONFLICT(id) DO UPDATE SET ${updates.join(', ')}`
      : `INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})
         ON CONFLICT(id) DO NOTHING`
  db.prepare(sql).run(...cols.map((c) => normalizeValue(row[c])))
}

const tableColumnCache = new WeakMap<Database.Database, Map<string, string[]>>()

function tableColumns(db: Database.Database, table: string): string[] {
  let perDb = tableColumnCache.get(db)
  if (!perDb) {
    perDb = new Map<string, string[]>()
    tableColumnCache.set(db, perDb)
  }
  const cached = perDb.get(table)
  if (cached) return cached
  const cols = (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name)
  perDb.set(table, cols)
  return cols
}

function normalizeValue(v: unknown): string | number | bigint | Buffer | null {
  if (v === undefined || v === null) return null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') return v
  if (Buffer.isBuffer(v)) return v
  return JSON.stringify(v)
}
