// TASK-2245 — SQLite side of inbox attribution: the created_by column exists,
// round-trips, and pulling a remote INBOX-R-NNN row never moves the laptop's
// own inbox counter.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { initSchema } from '../domain/repositories/schema'
import { CounterRepository } from '../domain/repositories/counter-repository'
import { InboxRepository } from '../domain/repositories/inbox-repository'
import { pull, type PullSource } from './sync-pull'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  initSchema(db)
})
afterEach(() => db.close())

function inboxCounter(): number {
  const r = db.prepare("SELECT last_number FROM global_counters WHERE entity_type = 'inbox'").get() as
    | { last_number: number }
    | undefined
  return r ? r.last_number : 0
}

describe('TASK-2245 — inbox created_by on SQLite', () => {
  it('AC-1: inbox_items has a created_by column', () => {
    const cols = (db.pragma('table_info(inbox_items)') as Array<{ name: string }>).map((c) => c.name)
    expect(cols).toContain('created_by')
  })

  it('created_by round-trips through the SQLite repository, null by default', () => {
    const repo = new InboxRepository(db, new CounterRepository(db))
    expect(repo.create({ projectId: 'p', content: 'a', createdBy: 'an' }).createdBy).toBe('an')
    expect(repo.create({ projectId: 'p', content: 'b' }).createdBy).toBeNull()
  })

  it('AC-9: pulling INBOX-R-005 leaves the laptop inbox counter unchanged', async () => {
    const repo = new InboxRepository(db, new CounterRepository(db))
    repo.create({ projectId: 'p', content: 'local' }) // counter now 1
    const before = inboxCounter()
    const source: PullSource = {
      fetchSince: async () => [
        {
          table: 'inbox_items',
          rows: [
            {
              id: 'INBOX-R-005',
              project_id: 'p',
              workspace_id: null,
              content: 'captured remotely',
              status: 'raw',
              linked_task_id: null,
              created_by: 'an',
              created_at: '2026-10-01T00:00:00.000Z',
              updated_at: '2026-10-01T00:00:00.000Z',
              sync_updated_at: 50,
              sync_deleted_at: null,
              sync_origin: 'remote'
            }
          ]
        }
      ]
    }
    await pull(db, source)
    expect(db.prepare("SELECT created_by FROM inbox_items WHERE id = 'INBOX-R-005'").get()).toEqual({
      created_by: 'an'
    })
    expect(inboxCounter()).toBe(before)
    // control: the next local capture continues the laptop's own sequence
    expect(repo.create({ projectId: 'p', content: 'next' }).id).toBe(
      `INBOX-${String(before + 1).padStart(3, '0')}`
    )
  })
})
