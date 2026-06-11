// ADR-030 Phase 3 (979b) — pending_ops queue unit tests (in-memory SQLite).

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  createPendingOpsTable,
  enqueueOp,
  listPendingOps,
  deletePendingOp,
  countPendingOps,
  pendingOpRow
} from './pending-ops'
import type { PulledRow } from './sync-pull'

function row(id: string, lamport: number): PulledRow {
  return { id, content: 'x', sync_updated_at: lamport, sync_deleted_at: null, sync_origin: 'laptop' }
}

describe('pending-ops queue', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
    createPendingOpsTable(db)
  })

  it('enqueues FIFO and returns monotonic seq', () => {
    const s1 = enqueueOp(db, { tableName: 'inbox_items', rowId: 'INBOX-1', op: 'upsert', row: row('INBOX-1', 1), lamport: 1, enqueuedAt: 100 })
    const s2 = enqueueOp(db, { tableName: 'tasks', rowId: 'TASK-1', op: 'upsert', row: row('TASK-1', 2), lamport: 2, enqueuedAt: 200 })
    expect(s2).toBeGreaterThan(s1)
    expect(countPendingOps(db)).toBe(2)
    const ops = listPendingOps(db)
    expect(ops.map((o) => o.row_id)).toEqual(['INBOX-1', 'TASK-1'])
    expect(ops[0].op).toBe('upsert')
  })

  it('round-trips the payload back to a canonical row', () => {
    enqueueOp(db, { tableName: 'tasks', rowId: 'TASK-1', op: 'delete', row: row('TASK-1', 7), lamport: 7, enqueuedAt: 1 })
    const [op] = listPendingOps(db)
    expect(pendingOpRow(op)).toMatchObject({ id: 'TASK-1', sync_updated_at: 7 })
  })

  it('deletes a drained op and honors the limit', () => {
    const s1 = enqueueOp(db, { tableName: 'tasks', rowId: 'A', op: 'upsert', row: row('A', 1), lamport: 1, enqueuedAt: 1 })
    enqueueOp(db, { tableName: 'tasks', rowId: 'B', op: 'upsert', row: row('B', 2), lamport: 2, enqueuedAt: 2 })
    expect(listPendingOps(db, 1)).toHaveLength(1)
    deletePendingOp(db, s1)
    expect(countPendingOps(db)).toBe(1)
    expect(listPendingOps(db)[0].row_id).toBe('B')
  })
})
