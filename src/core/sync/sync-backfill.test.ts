// TASK-3343 — backfill of rows written outside sync mode, against a real schema
// and a fake sink: unstamped rows are stamped and pushed parent-first, a second
// run finds nothing, and a sink failure queues every row to pending_ops.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { initSchema } from '../domain/repositories/schema'
import { backfillUnstamped } from './sync-backfill'
import { countPendingOps, listPendingOps } from './pending-ops'
import type { ApplyResult, ApplySink, RowVerdict } from './sync-apply'
import type { TableDelta } from './sync-pull'

class RecordingSink implements ApplySink {
  calls: TableDelta[][] = []
  fail = false
  conflictIds = new Set<string>()
  async applyDelta(deltas: TableDelta[]): Promise<ApplyResult> {
    if (this.fail) throw new Error('offline')
    this.calls.push(deltas)
    const verdicts: RowVerdict[] = deltas.flatMap((d) =>
      d.rows.map((r) => ({
        table: d.table,
        id: r.id,
        verdict: this.conflictIds.has(r.id) ? ('conflict' as const) : ('applied' as const),
        canonicalLamport: r.sync_updated_at
      }))
    )
    return { applied: verdicts.length, tombstoned: 0, conflicts: 0, verdicts }
  }
}

function unstampedCount(db: Database.Database, table: string): number {
  return (
    db.prepare(`SELECT count(*) n FROM ${table} WHERE sync_updated_at IS NULL`).get() as {
      n: number
    }
  ).n
}

describe('backfillUnstamped', () => {
  let db: Database.Database
  let sink: RecordingSink

  beforeEach(() => {
    db = new Database(':memory:')
    initSchema(db)
    sink = new RecordingSink()
    db.prepare(`INSERT INTO projects (id, name, cwd) VALUES ('ba-nghiep', 'BA', '/r/ba')`).run()
    db.prepare(
      `INSERT INTO projects (id, name, cwd, sync_updated_at, sync_origin) VALUES ('old', 'Old', '/r/o', 5, 'laptop')`
    ).run()
    db.prepare(
      `INSERT INTO workspaces (id, project_id, label, cwd) VALUES ('ba-main', 'ba-nghiep', 'main', '/r/ba')`
    ).run()
  })
  afterEach(() => db.close())

  it('stamps unstamped projects + workspaces and pushes them, project first', async () => {
    const report = await backfillUnstamped(db, sink)

    expect(unstampedCount(db, 'projects')).toBe(0)
    expect(unstampedCount(db, 'workspaces')).toBe(0)
    expect(sink.calls.map((c) => c[0].table)).toEqual(['projects', 'workspaces'])
    expect(sink.calls[0][0].rows.map((r) => r.id)).toEqual(['ba-nghiep']) // 'old' was stamped
    expect(sink.calls[0][0].rows[0].sync_origin).toBe('laptop')
    expect(report.counts).toEqual([
      { table: 'projects', stamped: 1, pushed: 1, conflicts: 0, queued: 0 },
      { table: 'workspaces', stamped: 1, pushed: 1, conflicts: 0, queued: 0 }
    ])
    expect(report.error).toBeNull()
  })

  it('is idempotent — a second run stamps and pushes nothing', async () => {
    await backfillUnstamped(db, sink)
    const second = await backfillUnstamped(db, sink)

    expect(sink.calls).toHaveLength(2) // only the first run pushed
    expect(second.counts.every((c) => c.stamped === 0 && c.pushed === 0)).toBe(true)
  })

  it('queues every stamped row to pending_ops when the sink fails', async () => {
    sink.fail = true
    const report = await backfillUnstamped(db, sink)

    expect(countPendingOps(db)).toBe(2)
    expect(listPendingOps(db).map((op) => `${op.table_name}:${op.row_id}`)).toEqual([
      'projects:ba-nghiep',
      'workspaces:ba-main'
    ])
    expect(report.counts.map((c) => c.queued)).toEqual([1, 1])
    expect(report.error).toBe('offline')
  })

  it('reports a remote conflict instead of counting it as pushed', async () => {
    sink.conflictIds.add('ba-nghiep')
    const report = await backfillUnstamped(db, sink)

    expect(report.counts[0]).toMatchObject({ stamped: 1, pushed: 0, conflicts: 1 })
  })

  it('leaves soft-deleted rows alone', async () => {
    db.prepare(`UPDATE workspaces SET sync_deleted_at = 9 WHERE id = 'ba-main'`).run()
    const report = await backfillUnstamped(db, sink)

    expect(report.counts[1].stamped).toBe(0)
  })
})
