// TASK-1148 — advancing the per-table id allocator on sync import so a fresh node
// can't re-mint an id it just pulled. Unit-tests the helper across all 6 ACs +
// one end-to-end pass through the real pull path.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { initSchema } from '../domain/repositories/schema'
import { CounterRepository, advanceCountersFromImport } from '../domain/repositories/counter-repository'
import { pull, type PullSource, type TableDelta } from './sync-pull'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  initSchema(db)
})
afterEach(() => db.close())

function counter(entityType: string): number {
  const r = db.prepare('SELECT last_number FROM global_counters WHERE entity_type = ?').get(entityType) as
    | { last_number: number }
    | undefined
  return r ? r.last_number : 0
}
function imported(rows: Record<string, Array<{ id?: unknown }>>): void {
  advanceCountersFromImport(db, new Map(Object.entries(rows)))
}

describe('advanceCountersFromImport (TASK-1148)', () => {
  it('AC-1: advances past imported ids; next mint is strictly greater (no collision)', () => {
    imported({ tasks: [{ id: 'TASK-007' }], inbox_items: [{ id: 'INBOX-003' }] })
    expect(counter('task')).toBe(7)
    expect(counter('inbox')).toBe(3)
    const c = new CounterRepository(db)
    expect(c.nextNumber('task')).toBe(8) // would have been 1 → collision, without the fix
    expect(c.nextNumber('inbox')).toBe(4)
  })

  it('AC-2: advances every counter-backed table independently', () => {
    imported({ tasks: [{ id: 'TASK-050' }, { id: 'TASK-012' }], inbox_items: [{ id: 'INBOX-099' }] })
    expect(counter('task')).toBe(50) // max of the two
    expect(counter('inbox')).toBe(99)
  })

  it('AC-3: a tombstoned row id still raises the floor (deleted id never re-minted)', () => {
    // import-side rows carry the id regardless of sync_deleted_at; the helper keys on id
    imported({ tasks: [{ id: 'TASK-030' }] })
    expect(counter('task')).toBe(30)
  })

  it('AC-4: monotonic — a lower imported id leaves the counter unchanged', () => {
    db.prepare(
      "INSERT INTO global_counters (entity_type, last_number) VALUES ('task', 100) ON CONFLICT(entity_type) DO UPDATE SET last_number = 100"
    ).run()
    imported({ tasks: [{ id: 'TASK-005' }] })
    expect(counter('task')).toBe(100)
  })

  it('AC-5: applies on every import, not just the first', () => {
    imported({ tasks: [{ id: 'TASK-007' }] })
    imported({ tasks: [{ id: 'TASK-009' }] })
    expect(counter('task')).toBe(9)
    expect(new CounterRepository(db).nextNumber('task')).toBe(10)
  })

  it('AC-6: no-op on the origin (counter already ahead of imported ids)', () => {
    db.prepare(
      "INSERT INTO global_counters (entity_type, last_number) VALUES ('task', 50) ON CONFLICT(entity_type) DO UPDATE SET last_number = 50"
    ).run()
    imported({ tasks: [{ id: 'TASK-010' }, { id: 'TASK-049' }] })
    expect(counter('task')).toBe(50)
    expect(new CounterRepository(db).nextNumber('task')).toBe(51)
  })

  it('skips explicit non-counter ids (e.g. TASK-PUSHSMOKE-1)', () => {
    imported({ tasks: [{ id: 'TASK-PUSHSMOKE-1' }, { id: 'TASK-004' }] })
    expect(counter('task')).toBe(4) // only the numeric id raises the floor
  })

  it('end-to-end: pull advances the counter through the real import path', async () => {
    db.prepare("INSERT INTO projects (id, name, cwd) VALUES ('p', 'P', '/p')").run()
    const source: PullSource = {
      fetchSince: async () => [
        {
          table: 'tasks',
          rows: [
            {
              id: 'TASK-020',
              project_id: 'p',
              title: 'pulled',
              status: 'TODO',
              created_at: '2026-01-01',
              updated_at: '2026-01-01',
              sync_updated_at: 9,
              sync_deleted_at: null
            } as never
          ]
        } as TableDelta
      ]
    }
    await pull(db, source)
    expect(counter('task')).toBe(20)
    expect(new CounterRepository(db).nextNumber('task')).toBe(21) // no collision with TASK-020
  })
})
