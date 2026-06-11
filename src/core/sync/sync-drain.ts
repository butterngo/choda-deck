// ADR-030 Phase 3 (TASK-1065 / 979c) — drain the offline queue to the remote
// under LWW, surfacing dropped ops so loss is never silent.
//
// Each pending_op is POSTed to the remote via the ApplySink (HttpWriteClient →
// POST /sync/apply), which applies server-side LWW and returns a per-row verdict:
// - applied / tombstoned → the op landed; delete it from the queue.
// - conflict            → the canonical row was newer; the op is DROPPED. Record
//                         it to sync_conflicts AND surface it (onConflict →
//                         inbox_add) so Butter sees the loss. Delete it too —
//                         retrying a stale op would loop forever.
// A network error mid-drain (remote went down) STOPS the cycle: remaining ops
// stay queued in seq order for the next reconnect. Idempotent — re-draining an
// already-applied op just gets a conflict/no-op verdict from the canonical store.

import type Database from 'better-sqlite3'
import type { ApplySink } from './sync-apply'
import {
  listPendingOps,
  deletePendingOp,
  countPendingOps,
  pendingOpRow,
  type PendingOp
} from './pending-ops'

export interface ConflictRecord {
  tableName: string
  rowId: string
  op: 'upsert' | 'delete'
  lamport: number // the pushed (losing) Lamport value
  canonicalLamport: number // the canonical value that beat it
}

export interface DrainOptions {
  origin: string
  // Connectivity gate — skip the cycle when the remote is unreachable.
  isReachable: () => Promise<boolean>
  // Surfacing hook for a dropped op (wired to a raw inbox_add in sync mode).
  // The durable record is always written to sync_conflicts regardless.
  onConflict?: (conflict: ConflictRecord) => void | Promise<void>
  // Wall-clock stamp for the sync_conflicts row (injectable for tests).
  detectedAt?: number
  limit?: number
}

export interface DrainResult {
  reachable: boolean
  drained: number // ops the remote accepted
  conflicts: number // ops dropped by LWW
  remaining: number // still queued after this cycle
}

export function createSyncConflictsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_conflicts (
      id INTEGER PRIMARY KEY,
      table_name TEXT NOT NULL,
      row_id TEXT NOT NULL,
      op TEXT NOT NULL,
      lamport INTEGER NOT NULL,
      canonical_lamport INTEGER NOT NULL,
      detected_at INTEGER NOT NULL
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_sync_conflicts_row ON sync_conflicts(table_name, row_id)')
}

export async function drainPendingOps(
  db: Database.Database,
  sink: ApplySink,
  opts: DrainOptions
): Promise<DrainResult> {
  if (!(await opts.isReachable())) {
    return { reachable: false, drained: 0, conflicts: 0, remaining: countPendingOps(db) }
  }

  const ops = listPendingOps(db, opts.limit)
  let drained = 0
  let conflicts = 0

  for (const op of ops) {
    let outcome: { dropped: boolean; canonicalLamport: number }
    try {
      outcome = await pushOne(sink, opts.origin, op)
    } catch {
      // Remote went down mid-drain — stop, leave this op and the rest queued.
      break
    }
    if (outcome.dropped) {
      const conflict: ConflictRecord = {
        tableName: op.table_name,
        rowId: op.row_id,
        op: op.op,
        lamport: op.lamport,
        canonicalLamport: outcome.canonicalLamport
      }
      recordConflict(db, conflict, opts.detectedAt ?? Date.now())
      if (opts.onConflict) await opts.onConflict(conflict)
      conflicts++
    } else {
      drained++
    }
    deletePendingOp(db, op.seq)
  }

  return { reachable: true, drained, conflicts, remaining: countPendingOps(db) }
}

// Push a single op; report whether the remote DROPPED it (LWW conflict) and the
// canonical Lamport that beat it.
async function pushOne(
  sink: ApplySink,
  origin: string,
  op: PendingOp
): Promise<{ dropped: boolean; canonicalLamport: number }> {
  const result = await sink.applyDelta([{ table: op.table_name, rows: [pendingOpRow(op)] }], origin)
  const verdict = result.verdicts.find((v) => v.id === op.row_id)
  if (verdict?.verdict === 'conflict') {
    return { dropped: true, canonicalLamport: verdict.canonicalLamport }
  }
  return { dropped: false, canonicalLamport: verdict?.canonicalLamport ?? 0 }
}

function recordConflict(db: Database.Database, c: ConflictRecord, detectedAt: number): void {
  db.prepare(
    `INSERT INTO sync_conflicts (table_name, row_id, op, lamport, canonical_lamport, detected_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(c.tableName, c.rowId, c.op, c.lamport, c.canonicalLamport, detectedAt)
}
