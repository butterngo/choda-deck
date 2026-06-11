// ADR-030 Phase 3 (979c) — drain loop unit tests. Docker-free: in-memory SQLite
// pending_ops + a fake ApplySink returning canned verdicts (or throwing to
// simulate the remote going down mid-drain).

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { createPendingOpsTable, enqueueOp, countPendingOps } from './pending-ops'
import { createSyncConflictsTable, drainPendingOps, type ConflictRecord } from './sync-drain'
import type { ApplySink, ApplyResult, RowVerdict } from './sync-apply'
import type { TableDelta, PulledRow } from './sync-pull'

function row(id: string, lamport: number): PulledRow {
  return { id, content: 'x', sync_updated_at: lamport, sync_deleted_at: null, sync_origin: 'laptop' }
}

// Sink whose verdict for a row id is scripted; unknown ids default to 'applied'.
class ScriptedSink implements ApplySink {
  failAfter = Infinity
  private seen = 0
  constructor(private readonly verdicts: Record<string, RowVerdict['verdict']> = {}) {}
  async applyDelta(deltas: TableDelta[], _origin: string): Promise<ApplyResult> {
    this.seen++
    if (this.seen > this.failAfter) throw new Error('remote down')
    const verdicts: RowVerdict[] = []
    for (const d of deltas) {
      for (const r of d.rows) {
        const v = this.verdicts[r.id] ?? 'applied'
        verdicts.push({ table: d.table, id: r.id, verdict: v, canonicalLamport: v === 'conflict' ? 99 : r.sync_updated_at })
      }
    }
    return {
      applied: verdicts.filter((v) => v.verdict === 'applied').length,
      tombstoned: verdicts.filter((v) => v.verdict === 'tombstoned').length,
      conflicts: verdicts.filter((v) => v.verdict === 'conflict').length,
      verdicts
    }
  }
}

describe('drainPendingOps', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
    createPendingOpsTable(db)
    createSyncConflictsTable(db)
  })

  function enqueue(id: string, lamport: number): void {
    enqueueOp(db, { tableName: 'inbox_items', rowId: id, op: 'upsert', row: row(id, lamport), lamport, enqueuedAt: lamport })
  }

  const reachable = (): Promise<boolean> => Promise.resolve(true)

  it('skips the cycle when the remote is unreachable (queue intact)', async () => {
    enqueue('A', 1)
    const res = await drainPendingOps(db, new ScriptedSink(), {
      origin: 'laptop',
      isReachable: () => Promise.resolve(false)
    })
    expect(res).toMatchObject({ reachable: false, drained: 0, remaining: 1 })
    expect(countPendingOps(db)).toBe(1)
  })

  it('drains accepted ops and empties the queue', async () => {
    enqueue('A', 1)
    enqueue('B', 2)
    const res = await drainPendingOps(db, new ScriptedSink(), { origin: 'laptop', isReachable: reachable })
    expect(res).toMatchObject({ reachable: true, drained: 2, conflicts: 0, remaining: 0 })
    expect(countPendingOps(db)).toBe(0)
  })

  it('records a dropped op to sync_conflicts + fires onConflict, then removes it', async () => {
    enqueue('A', 1)
    const seen: ConflictRecord[] = []
    const res = await drainPendingOps(db, new ScriptedSink({ A: 'conflict' }), {
      origin: 'laptop',
      isReachable: reachable,
      onConflict: (c) => {
        seen.push(c)
      },
      detectedAt: 1234
    })
    expect(res).toMatchObject({ drained: 0, conflicts: 1, remaining: 0 })
    expect(seen[0]).toMatchObject({ rowId: 'A', canonicalLamport: 99, lamport: 1 })
    const conflictRows = db.prepare('SELECT row_id, canonical_lamport, detected_at FROM sync_conflicts').all()
    expect(conflictRows).toEqual([{ row_id: 'A', canonical_lamport: 99, detected_at: 1234 }])
    expect(countPendingOps(db)).toBe(0) // dropped op removed (no infinite retry)
  })

  it('stops mid-drain when the remote dies, leaving the rest queued in order', async () => {
    enqueue('A', 1)
    enqueue('B', 2)
    enqueue('C', 3)
    const sink = new ScriptedSink()
    sink.failAfter = 1 // first push OK, second throws
    const res = await drainPendingOps(db, sink, { origin: 'laptop', isReachable: reachable })
    expect(res).toMatchObject({ reachable: true, drained: 1, remaining: 2 })
    expect(countPendingOps(db)).toBe(2)
  })
})
