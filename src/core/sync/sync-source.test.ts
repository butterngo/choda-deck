import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { initSchema } from '../domain/repositories/schema'
import { InboxRepository } from '../domain/repositories/inbox-repository'
import { CounterRepository } from '../domain/repositories/counter-repository'
import { fetchSinceFromSqlite } from './sync-source'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  initSchema(db)
})

afterEach(() => {
  db.close()
})

function addInbox(id: string, syncUpdatedAt: number | null, deletedAt: number | null = null): void {
  db.prepare(
    `INSERT INTO inbox_items (id, content, status, created_at, updated_at, sync_updated_at, sync_deleted_at, sync_origin)
     VALUES (?, 'c', 'raw', '2026-01-01', '2026-01-01', ?, ?, 'remote')`
  ).run(id, syncUpdatedAt, deletedAt)
}

describe('fetchSinceFromSqlite', () => {
  it('returns only rows changed after the cursor', () => {
    addInbox('I1', 3)
    addInbox('I2', 7)
    addInbox('I3', 10)
    const deltas = fetchSinceFromSqlite(db, 5)
    const inbox = deltas.find((d) => d.table === 'inbox_items')
    expect(inbox?.rows.map((r) => r.id).sort()).toEqual(['I2', 'I3'])
  })

  it('includes tombstoned rows whose sync_deleted_at is past the cursor', () => {
    addInbox('I1', 4, 9) // updated_at=4 (<= cursor) but deleted_at=9 (> cursor)
    const deltas = fetchSinceFromSqlite(db, 5)
    const inbox = deltas.find((d) => d.table === 'inbox_items')
    expect(inbox?.rows.map((r) => r.id)).toEqual(['I1'])
  })

  it('omits tables with no changed rows (NULL sync_updated_at never matches)', () => {
    addInbox('I1', null) // unstamped — pre-Phase-2 row
    const deltas = fetchSinceFromSqlite(db, 0)
    expect(deltas).toEqual([])
  })

  it('returns an empty array when nothing changed since the cursor', () => {
    addInbox('I1', 2)
    expect(fetchSinceFromSqlite(db, 100)).toEqual([])
  })

  // Regression: a remote (HTTP-canonical) inbox_add must surface to the pull —
  // InboxRepository.create stamps sync_updated_at via the Lamport clock, else the
  // row stays NULL-stamped and never drains to the laptop (TASK-1074 AC-4 gap).
  it('a repo-created inbox row is stamped and surfaces in fetchSince', () => {
    const repo = new InboxRepository(db, new CounterRepository(db))
    const created = repo.create({ projectId: 'p', content: 'remote capture' })
    const deltas = fetchSinceFromSqlite(db, 0)
    const row = deltas.find((d) => d.table === 'inbox_items')?.rows.find((r) => r.id === created.id)
    expect(row).toBeDefined()
    expect(row?.sync_updated_at as number).toBeGreaterThan(0)
    expect(row?.sync_origin).toBe('remote')
  })
})
