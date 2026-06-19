// ADR-030 Phase 3 (TASK-1063 / 979a) — the SINK side of sync: apply pushed
// deltas into the canonical store under server-side LWW. Symmetric to the read
// producers in sync-source.ts (fetchSince*). The Postgres variant backs
// POST /sync/apply; the SQLite variant exists for parity (local-source tests, a
// future SQLite-to-SQLite push) and a Docker-free unit-test path for the LWW core.
//
// Conflict rule (ADR-030 §Conflict rule, write side): the canonical store wins
// ties — see planApplyRow in sync-apply.ts. Tombstones are SOFT here (set
// sync_deleted_at, keep the row) — unlike sync-pull which hard-deletes locally —
// because the canonical store must keep retiring rows visible to fetchSince so
// the tombstone propagates to every other device. Filtering soft-deleted rows
// out of reads is a follow-up (task delete is not yet wired through write-through).

import type Database from 'better-sqlite3'
import type { PgConnection, Queryable } from '../domain/repositories/postgres/connection'
import { ConversationRepository } from '../domain/repositories/conversation-repository'
import { mergeClock } from './lamport-clock'
import type { PulledRow, TableDelta } from './sync-pull'
import {
  APPLY_TABLES,
  assertApplyTables,
  planApplyRow,
  type ApplyResult,
  type RowVerdict
} from './sync-apply'

// Apply pushed deltas into canonical Postgres. One transaction covers the whole
// push so a partial failure rolls back and the pusher re-drains cleanly.
export async function applyDeltaToPg(
  conn: PgConnection,
  deltas: TableDelta[],
  origin: string
): Promise<ApplyResult> {
  assertApplyTables(deltas)
  const verdicts: RowVerdict[] = []
  let applied = 0
  let tombstoned = 0
  let conflicts = 0
  let maxLamport = 0

  await conn.transaction(async (tx) => {
    for (const delta of deltas) {
      const cols = await pgColumns(tx, delta.table)
      for (const row of delta.rows) {
        maxLamport = Math.max(maxLamport, row.sync_updated_at)
        const cur = await tx.query<{ sync_updated_at: string | null }>(
          `SELECT sync_updated_at FROM ${delta.table} WHERE id = $1`,
          [row.id]
        )
        const existing = cur.rows[0]
        const canonical =
          existing && existing.sync_updated_at !== null ? Number(existing.sync_updated_at) : null
        const verdict = planApplyRow(canonical, row)

        if (verdict === 'conflict') {
          conflicts++
          verdicts.push({ table: delta.table, id: row.id, verdict, canonicalLamport: canonical ?? 0 })
          continue
        }
        if (verdict === 'tombstoned') {
          if (existing) {
            await tx.query(
              `UPDATE ${delta.table} SET sync_deleted_at = $1, sync_updated_at = $2, sync_origin = $3 WHERE id = $4`,
              [
                row.sync_deleted_at ?? null,
                row.sync_updated_at,
                (row.sync_origin as string | null) ?? origin,
                row.id
              ]
            )
          }
          tombstoned++
          verdicts.push({ table: delta.table, id: row.id, verdict, canonicalLamport: row.sync_updated_at })
          continue
        }
        await upsertPgRow(tx, delta.table, cols, row, origin)
        applied++
        verdicts.push({ table: delta.table, id: row.id, verdict, canonicalLamport: row.sync_updated_at })
      }
    }
    // Advance the canonical Lamport clock past everything just pushed so the
    // store's own next write outranks the pulled values (symmetric to the
    // mergeClock the pull side runs locally).
    if (maxLamport > 0) {
      await tx.query('UPDATE _sync_clock SET counter = GREATEST(counter, $1) WHERE id = 0', [
        maxLamport
      ])
    }
  })

  return { applied, tombstoned, conflicts, verdicts }
}

// SQLite variant — synchronous (better-sqlite3), no per-column coercion (SQLite
// is typeless so the pushed wire shape inserts directly).
export function applyDeltaToSqlite(
  db: Database.Database,
  deltas: TableDelta[],
  origin: string
): ApplyResult {
  assertApplyTables(deltas)
  const verdicts: RowVerdict[] = []
  let applied = 0
  let tombstoned = 0
  let conflicts = 0
  let maxLamport = 0

  const run = db.transaction(() => {
    for (const delta of deltas) {
      for (const row of delta.rows) {
        maxLamport = Math.max(maxLamport, row.sync_updated_at)
        const existing = db
          .prepare(`SELECT sync_updated_at FROM ${delta.table} WHERE id = ?`)
          .get(row.id) as { sync_updated_at: number | null } | undefined
        const canonical =
          existing && existing.sync_updated_at !== null ? existing.sync_updated_at : null
        const verdict = planApplyRow(canonical, row)

        if (verdict === 'conflict') {
          conflicts++
          verdicts.push({ table: delta.table, id: row.id, verdict, canonicalLamport: canonical ?? 0 })
          continue
        }
        if (verdict === 'tombstoned') {
          if (existing) {
            db.prepare(
              `UPDATE ${delta.table} SET sync_deleted_at = ?, sync_updated_at = ?, sync_origin = ? WHERE id = ?`
            ).run(row.sync_deleted_at ?? null, row.sync_updated_at, row.sync_origin ?? origin, row.id)
          }
          tombstoned++
          verdicts.push({ table: delta.table, id: row.id, verdict, canonicalLamport: row.sync_updated_at })
          continue
        }
        upsertSqliteRow(db, delta.table, row, origin)
        applied++
        verdicts.push({ table: delta.table, id: row.id, verdict, canonicalLamport: row.sync_updated_at })
      }
    }
    if (maxLamport > 0) mergeClock(db, maxLamport)
  })
  run()

  // TASK-1067/1136 — refold derived headers for conversations whose message log
  // just changed, so status/decisionSummary converge with the appended turns.
  const affectedConvIds = new Set<string>()
  for (const delta of deltas) {
    if (delta.table !== 'conversation_messages') continue
    for (const row of delta.rows) {
      if (typeof row.conversation_id === 'string') affectedConvIds.add(row.conversation_id)
    }
  }
  if (affectedConvIds.size > 0) {
    const convRepo = new ConversationRepository(db)
    for (const cid of affectedConvIds) convRepo.recomputeHeader(cid)
  }

  return { applied, tombstoned, conflicts, verdicts }
}

// --- Postgres helpers -------------------------------------------------------

// INSERT … ON CONFLICT(id) DO UPDATE, intersecting the pushed row's keys with the
// table's real columns (drift-resilient). Values are coerced from the SQLite wire
// shape to the Postgres column type.
async function upsertPgRow(
  tx: Queryable,
  table: string,
  columnTypes: Map<string, string>,
  row: PulledRow,
  origin: string
): Promise<void> {
  const cols = Object.keys(row)
    .filter((k) => columnTypes.has(k))
    .sort()
  if (cols.length === 0) return
  const values = cols.map((c) =>
    coercePgValue(columnTypes.get(c) ?? 'text', c === 'sync_origin' ? (row[c] ?? origin) : row[c])
  )
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(',')
  const updates = cols.filter((c) => c !== 'id').map((c) => `${c} = EXCLUDED.${c}`)
  const sql =
    updates.length > 0
      ? `INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})
         ON CONFLICT (id) DO UPDATE SET ${updates.join(', ')}`
      : `INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})
         ON CONFLICT (id) DO NOTHING`
  await tx.query(sql, values)
}

// Coerce a SQLite-shaped value to what the Postgres column expects. SQLite has no
// native boolean/json/timestamp types, so a pushed row carries 0/1 for booleans,
// a JSON *string* for jsonb, and an ISO string for timestamptz. node-pg would
// mis-serialize a JS array into a PG array literal for a jsonb column, so
// objects/arrays are stringified; PG casts the text→jsonb on assignment.
function coercePgValue(dataType: string, v: unknown): string | number | boolean | null {
  if (v === undefined || v === null) return null
  if (dataType === 'boolean') {
    if (typeof v === 'boolean') return v
    if (typeof v === 'number') return v !== 0
    if (typeof v === 'string') return v === '1' || v.toLowerCase() === 'true'
    return Boolean(v)
  }
  if (dataType === 'jsonb' || dataType === 'json') {
    return typeof v === 'string' ? v : JSON.stringify(v)
  }
  if (typeof v === 'object') return JSON.stringify(v)
  return v as string | number | boolean
}

// information_schema column→data_type map, cached per tx client. Restricted to
// APPLY_TABLES so an out-of-scope identifier can never reach the query.
const pgColumnCache = new WeakMap<object, Map<string, Map<string, string>>>()

async function pgColumns(tx: Queryable, table: string): Promise<Map<string, string>> {
  if (!APPLY_TABLES.includes(table)) {
    throw new Error(`sync apply: table not in apply scope: ${table}`)
  }
  let perConn = pgColumnCache.get(tx)
  if (!perConn) {
    perConn = new Map<string, Map<string, string>>()
    pgColumnCache.set(tx, perConn)
  }
  const cached = perConn.get(table)
  if (cached) return cached
  const result = await tx.query<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1`,
    [table]
  )
  const map = new Map<string, string>()
  for (const r of result.rows) map.set(r.column_name, r.data_type)
  perConn.set(table, map)
  return map
}

// --- SQLite helpers ---------------------------------------------------------

function upsertSqliteRow(
  db: Database.Database,
  table: string,
  row: PulledRow,
  origin: string
): void {
  const targetCols = new Set(sqliteColumns(db, table))
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
  db.prepare(sql).run(
    ...cols.map((c) => normalizeSqliteValue(c === 'sync_origin' ? (row[c] ?? origin) : row[c]))
  )
}

function normalizeSqliteValue(v: unknown): string | number | bigint | Buffer | null {
  if (v === undefined || v === null) return null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') return v
  if (Buffer.isBuffer(v)) return v
  return JSON.stringify(v)
}

const sqliteColumnCache = new WeakMap<Database.Database, Map<string, string[]>>()

function sqliteColumns(db: Database.Database, table: string): string[] {
  let perDb = sqliteColumnCache.get(db)
  if (!perDb) {
    perDb = new Map<string, string[]>()
    sqliteColumnCache.set(db, perDb)
  }
  const cached = perDb.get(table)
  if (cached) return cached
  const cols = (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name)
  perDb.set(table, cols)
  return cols
}
