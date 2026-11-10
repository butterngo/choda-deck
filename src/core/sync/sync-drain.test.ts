// ADR-030 Phase 3 (979c) — drain loop unit tests. Docker-free: in-memory SQLite
// pending_ops + a fake ApplySink returning canned verdicts (or throwing to
// simulate the remote going down mid-drain).

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { createPendingOpsTable, enqueueOp, countPendingOps } from './pending-ops'
import { createSyncConflictsTable, drainPendingOps, type ConflictRecord } from './sync-drain'
import { SyncApplyError } from './http-write-client'
import { createSyncClockTables, peek } from './lamport-clock'
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

  it('skips a 4xx-rejected op and keeps draining the rest (no stall)', async () => {
    enqueue('A', 1) // remote permanently rejects this one (400)
    enqueue('B', 2)
    enqueue('C', 3)
    const sink: ApplySink = {
      async applyDelta(deltas) {
        const id = deltas[0].rows[0].id
        if (id === 'A') throw new SyncApplyError('sync apply: POST /sync/apply -> HTTP 400', 400)
        return { applied: 1, tombstoned: 0, conflicts: 0, verdicts: [{ table: deltas[0].table, id, verdict: 'applied', canonicalLamport: 0 }] }
      }
    }
    const res = await drainPendingOps(db, sink, { origin: 'laptop', isReachable: reachable })
    expect(res).toMatchObject({ reachable: true, drained: 2, rejected: 1, remaining: 0 })
    expect(countPendingOps(db)).toBe(0) // A dropped (won't block), B+C drained
  })

  it('still stops on a 5xx/transient error, leaving the op queued', async () => {
    enqueue('A', 1)
    enqueue('B', 2)
    const sink: ApplySink = {
      async applyDelta(deltas) {
        if (deltas[0].rows[0].id === 'A') throw new SyncApplyError('HTTP 503', 503)
        return { applied: 1, tombstoned: 0, conflicts: 0, verdicts: [] }
      }
    }
    const res = await drainPendingOps(db, sink, { origin: 'laptop', isReachable: reachable })
    expect(res).toMatchObject({ reachable: true, drained: 0, rejected: 0, remaining: 2 })
    expect(countPendingOps(db)).toBe(2) // transient → nothing dropped
  })
})

// TASK-3202 — an accepted op adopts the canonical re-stamp: the local row moves
// to what the store actually wrote, and the clock merges past it.
describe('drainPendingOps — adopts the canonical re-stamp (TASK-3202)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
    createPendingOpsTable(db)
    createSyncConflictsTable(db)
    createSyncClockTables(db)
    db.exec(
      'CREATE TABLE inbox_items (id TEXT PRIMARY KEY, content TEXT, sync_updated_at INTEGER, sync_deleted_at INTEGER, sync_origin TEXT)'
    )
  })

  function seed(id: string, lamport: number): void {
    db.prepare('INSERT INTO inbox_items VALUES (?, ?, ?, NULL, ?)').run(id, 'x', lamport, 'laptop')
    enqueueOp(db, { tableName: 'inbox_items', rowId: id, op: 'upsert', row: row(id, lamport), lamport, enqueuedAt: lamport })
  }

  function stampingSink(stampTo: number | undefined): ApplySink {
    return {
      async applyDelta(deltas: TableDelta[]): Promise<ApplyResult> {
        const verdicts: RowVerdict[] = deltas.flatMap((d) =>
          d.rows.map((r) => ({
            table: d.table,
            id: r.id,
            verdict: 'applied' as const,
            canonicalLamport: stampTo ?? r.sync_updated_at,
            ...(stampTo === undefined ? {} : { stamped: stampTo })
          }))
        )
        return { applied: verdicts.length, tombstoned: 0, conflicts: 0, verdicts }
      }
    }
  }

  const stampOf = (id: string): number =>
    (db.prepare('SELECT sync_updated_at FROM inbox_items WHERE id = ?').get(id) as { sync_updated_at: number })
      .sync_updated_at

  it('moves the local row to `stamped` and merges the clock', async () => {
    seed('A', 1)
    const res = await drainPendingOps(db, stampingSink(5001), { origin: 'laptop', isReachable: () => Promise.resolve(true) })
    expect(res).toMatchObject({ drained: 1, conflicts: 0 })
    expect(stampOf('A')).toBe(5001)
    expect(peek(db)).toBe(5001)
  })

  it('CONTROL — a verdict without `stamped` (older server) leaves the row and clock alone', async () => {
    seed('A', 1)
    await drainPendingOps(db, stampingSink(undefined), { origin: 'laptop', isReachable: () => Promise.resolve(true) })
    expect(stampOf('A')).toBe(1)
    expect(peek(db)).toBe(0)
  })

  it('does not drag back a row that was edited locally after the op was queued', async () => {
    seed('A', 1)
    db.prepare('UPDATE inbox_items SET sync_updated_at = 2 WHERE id = ?').run('A') // newer local edit
    await drainPendingOps(db, stampingSink(5001), { origin: 'laptop', isReachable: () => Promise.resolve(true) })
    expect(stampOf('A')).toBe(2)
    expect(peek(db)).toBe(5001) // the clock still merges — the next edit must outrank 5001
  })
})
