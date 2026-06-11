// ADR-030 Phase 3 (TASK-1064 / 979b) — the local-only offline queue. When the
// laptop is in sync mode and a write-through POST to the remote fails (offline /
// 5xx / timeout), the op is appended here and the tool call still returns success
// (consistency-then-enqueue, ADR-030 §Write semantics). The drain loop (979c)
// replays the queue on reconnect under LWW.
//
// SQLite-only — Postgres is canonical and never queues. `seq INTEGER PRIMARY KEY`
// aliases rowid, so it is monotonic and gives FIFO replay order.

import type Database from 'better-sqlite3'
import type { PulledRow } from './sync-pull'

export interface PendingOp {
  seq: number
  table_name: string
  row_id: string
  op: 'upsert' | 'delete'
  payload: string // canonical-JSON row
  lamport: number
  enqueued_at: number
}

export interface EnqueueInput {
  tableName: string
  rowId: string
  op: 'upsert' | 'delete'
  row: PulledRow
  lamport: number
  enqueuedAt: number
}

export function createPendingOpsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_ops (
      seq INTEGER PRIMARY KEY,
      table_name TEXT NOT NULL,
      row_id TEXT NOT NULL,
      op TEXT NOT NULL CHECK (op IN ('upsert','delete')),
      payload TEXT NOT NULL,
      lamport INTEGER NOT NULL,
      enqueued_at INTEGER NOT NULL
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_pending_ops_seq ON pending_ops(seq)')
}

export function enqueueOp(db: Database.Database, input: EnqueueInput): number {
  const info = db
    .prepare(
      `INSERT INTO pending_ops (table_name, row_id, op, payload, lamport, enqueued_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(input.tableName, input.rowId, input.op, JSON.stringify(input.row), input.lamport, input.enqueuedAt)
  return Number(info.lastInsertRowid)
}

export function listPendingOps(db: Database.Database, limit?: number): PendingOp[] {
  const sql = `SELECT seq, table_name, row_id, op, payload, lamport, enqueued_at
               FROM pending_ops ORDER BY seq ASC${limit ? ' LIMIT ?' : ''}`
  const stmt = db.prepare(sql)
  return (limit ? stmt.all(limit) : stmt.all()) as PendingOp[]
}

export function deletePendingOp(db: Database.Database, seq: number): void {
  db.prepare('DELETE FROM pending_ops WHERE seq = ?').run(seq)
}

export function countPendingOps(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM pending_ops').get() as { n: number }
  return row.n
}

// Parse a queued op's payload back into a canonical row for replay.
export function pendingOpRow(op: PendingOp): PulledRow {
  return JSON.parse(op.payload) as PulledRow
}
