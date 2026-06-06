import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { initSchema } from '../domain/repositories/schema'
import { getLastPullAt } from './lamport-clock'
import { pull, type PullSource, type TableDelta } from './sync-pull'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  initSchema(db)
  db.prepare("INSERT INTO projects (id, name, cwd) VALUES ('p', 'P', '/p')").run()
})

afterEach(() => {
  db.close()
})

// A canned source: returns the same deltas regardless of cursor unless a
// per-cursor map is supplied (used for the idempotent re-pull test).
function source(deltas: TableDelta[], bySince?: Record<number, TableDelta[]>): PullSource {
  return {
    fetchSince: async (since: number) =>
      bySince ? (bySince[since] ?? []) : deltas
  }
}

function seedTask(id: string, syncUpdatedAt: number | null, title = 'orig'): void {
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, status, created_at, updated_at, sync_updated_at)
     VALUES (?, 'p', ?, 'TODO', '2026-01-01', '2026-01-01', ?)`
  ).run(id, title, syncUpdatedAt)
}

function getTask(id: string): { title: string; sync_updated_at: number | null } | undefined {
  return db.prepare('SELECT title, sync_updated_at FROM tasks WHERE id = ?').get(id) as
    | { title: string; sync_updated_at: number | null }
    | undefined
}

const taskRow = (
  id: string,
  sync_updated_at: number,
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({
  id,
  project_id: 'p',
  title: 'remote',
  status: 'TODO',
  created_at: '2026-01-01',
  updated_at: '2026-01-01',
  sync_updated_at,
  sync_deleted_at: null,
  ...extra
})

describe('sync-pull — LWW reconcile', () => {
  it('inserts a brand-new remote row', async () => {
    const res = await pull(db, source([{ table: 'tasks', rows: [taskRow('T1', 7) as never] }]))
    expect(getTask('T1')).toEqual({ title: 'remote', sync_updated_at: 7 })
    expect(res.counts.find((c) => c.table === 'tasks')).toMatchObject({ upserted: 1, skipped: 0 })
  })

  it('keeps local when local.updated_at >= remote (skip rule)', async () => {
    seedTask('T1', 10, 'local-wins')
    const res = await pull(db, source([{ table: 'tasks', rows: [taskRow('T1', 5) as never] }]))
    expect(getTask('T1')).toEqual({ title: 'local-wins', sync_updated_at: 10 })
    expect(res.counts.find((c) => c.table === 'tasks')).toMatchObject({ upserted: 0, skipped: 1 })
  })

  it('overwrites local when remote.updated_at is newer', async () => {
    seedTask('T1', 5, 'stale-local')
    await pull(db, source([{ table: 'tasks', rows: [taskRow('T1', 9, { title: 'fresh' }) as never] }]))
    expect(getTask('T1')).toEqual({ title: 'fresh', sync_updated_at: 9 })
  })

  it('treats a NULL local updated_at as always losing to a stamped remote row', async () => {
    seedTask('T1', null, 'unstamped')
    await pull(db, source([{ table: 'tasks', rows: [taskRow('T1', 1, { title: 'won' }) as never] }]))
    expect(getTask('T1')).toEqual({ title: 'won', sync_updated_at: 1 })
  })

  it('propagates a tombstone — remote delete removes the local row', async () => {
    seedTask('T1', 5)
    const res = await pull(
      db,
      source([{ table: 'tasks', rows: [taskRow('T1', 12, { sync_deleted_at: 12 }) as never] }])
    )
    expect(getTask('T1')).toBeUndefined()
    expect(res.counts.find((c) => c.table === 'tasks')).toMatchObject({ tombstoned: 1 })
  })

  it('skips a tombstone when the local row is newer (delete loses LWW)', async () => {
    seedTask('T1', 20, 'survives')
    await pull(
      db,
      source([{ table: 'tasks', rows: [taskRow('T1', 12, { sync_deleted_at: 12 }) as never] }])
    )
    expect(getTask('T1')).toEqual({ title: 'survives', sync_updated_at: 20 })
  })

  it('advances last_pull_at to the highest Lamport value seen', async () => {
    expect(getLastPullAt(db)).toBe(0)
    const res = await pull(
      db,
      source([
        {
          table: 'tasks',
          rows: [taskRow('T1', 4) as never, taskRow('T2', 11, { sync_deleted_at: 15 }) as never]
        }
      ])
    )
    expect(res.newCursor).toBe(15)
    expect(getLastPullAt(db)).toBe(15)
  })

  it('is idempotent — a re-pull past the cursor applies nothing', async () => {
    const bySince = {
      0: [{ table: 'tasks', rows: [taskRow('T1', 8) as never] }],
      8: [] as TableDelta[]
    }
    await pull(db, source([], bySince))
    expect(getLastPullAt(db)).toBe(8)
    const second = await pull(db, source([], bySince))
    expect(second.counts.every((c) => c.upserted === 0 && c.tombstoned === 0)).toBe(true)
    expect(getLastPullAt(db)).toBe(8)
  })

  it('upserts a parent and child in one delta (parent-first ordering)', async () => {
    // workspace references project; both arrive in the same pull.
    const deltas: TableDelta[] = [
      {
        table: 'workspaces',
        rows: [
          {
            id: 'W1',
            project_id: 'p',
            label: 'WS',
            cwd: '/ws',
            sync_updated_at: 3,
            sync_deleted_at: null
          } as never
        ]
      }
    ]
    const res = await pull(db, source(deltas))
    const ws = db.prepare('SELECT label FROM workspaces WHERE id = ?').get('W1') as
      | { label: string }
      | undefined
    expect(ws?.label).toBe('WS')
    expect(res.counts.find((c) => c.table === 'workspaces')).toMatchObject({ upserted: 1 })
  })

  it('ignores deltas for non-syncable tables', async () => {
    const res = await pull(db, source([{ table: 'sessions', rows: [] }]))
    expect(res.counts.find((c) => c.table === 'sessions')).toBeUndefined()
  })
})
