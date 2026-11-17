// TASK-3343 — push rows that were written outside sync mode. Write-through stamps
// only inside the sync wrapper, so a plain stdio server (Claude Desktop on the
// deprecated bundle, or any pre-sync history) leaves rows with sync_updated_at
// NULL: they never reach the remote, and a later pull cannot heal them because
// the remote never had them. Backfill gives each such row a Lamport stamp and
// pushes it through the same sink write-through uses; on a remote failure the
// rows are queued to pending_ops for the drain loop, never dropped.
//
// Scope is projects + workspaces (FK parents a remote task needs). Tasks, inbox
// and conversations are deliberately left out — whether pre-sync history belongs
// on the remote is a separate decision.

import type Database from 'better-sqlite3'
import { tick } from './lamport-clock'
import { enqueueOp } from './pending-ops'
import type { ApplySink } from './sync-apply'
import type { PulledRow, TableDelta } from './sync-pull'
import { adoptStampedVerdicts } from './sync-stamp-adopt'

// Parent first, so the workspace's project exists on the receiver.
export const BACKFILL_TABLES = ['projects', 'workspaces'] as const

export interface BackfillTableCount {
  table: string
  stamped: number
  pushed: number
  conflicts: number
  queued: number
}

export interface BackfillReport {
  counts: BackfillTableCount[]
  error: string | null // why the push fell back to pending_ops, if it did
}

export async function backfillUnstamped(
  db: Database.Database,
  sink: ApplySink,
  origin = 'laptop'
): Promise<BackfillReport> {
  const counts: BackfillTableCount[] = []
  let error: string | null = null
  for (const table of BACKFILL_TABLES) {
    const rows = stampUnstamped(db, table, origin)
    const count: BackfillTableCount = {
      table,
      stamped: rows.length,
      pushed: 0,
      conflicts: 0,
      queued: 0
    }
    counts.push(count)
    if (rows.length === 0) continue

    const deltas: TableDelta[] = [{ table, rows }]
    try {
      const result = await sink.applyDelta(deltas, origin)
      adoptStampedVerdicts(db, deltas, result)
      count.conflicts = result.verdicts.filter((v) => v.verdict === 'conflict').length
      count.pushed = rows.length - count.conflicts
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      for (const row of rows) {
        enqueueOp(db, {
          tableName: table,
          rowId: row.id,
          op: 'upsert',
          row,
          lamport: row.sync_updated_at,
          enqueuedAt: Date.now()
        })
      }
      count.queued = rows.length
    }
  }
  return { counts, error }
}

// Stamp every unstamped live row of one table in a single transaction and return
// the stamped rows. A soft-deleted row is left alone — it has nothing to push.
function stampUnstamped(db: Database.Database, table: string, origin: string): PulledRow[] {
  const run = db.transaction((): PulledRow[] => {
    const ids = db
      .prepare(
        `SELECT id FROM ${table} WHERE sync_updated_at IS NULL AND sync_deleted_at IS NULL ORDER BY id`
      )
      .all() as Array<{ id: string }>
    const stamp = db.prepare(
      `UPDATE ${table} SET sync_updated_at = ?, sync_origin = ? WHERE id = ?`
    )
    const read = db.prepare(`SELECT * FROM ${table} WHERE id = ?`)
    return ids.map(({ id }) => {
      stamp.run(tick(db), origin, id)
      return read.get(id) as PulledRow
    })
  })
  return run()
}
