import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { computeLedger, LEDGER_ENTITIES } from './sync-ledger'

// Minimal fixture: each ledger table needs only id + the three ADR-030 sync
// columns for the classifier to read.
function fixtureDb(): Database.Database {
  const db = new Database(':memory:')
  for (const { table } of LEDGER_ENTITIES) {
    db.exec(
      `CREATE TABLE ${table} (
         id TEXT PRIMARY KEY,
         sync_origin TEXT,
         sync_updated_at INTEGER,
         sync_deleted_at INTEGER
       )`
    )
  }
  return db
}

function insert(
  db: Database.Database,
  table: string,
  id: string,
  origin: string | null,
  updatedAt: number | null,
  deletedAt: number | null
): void {
  db.prepare(
    `INSERT INTO ${table} (id, sync_origin, sync_updated_at, sync_deleted_at) VALUES (?, ?, ?, ?)`
  ).run(id, origin, updatedAt, deletedAt)
}

describe('computeLedger', () => {
  it('classifies each row into exactly one bucket by precedence', () => {
    const db = fixtureDb()
    // in-sync: laptop-stamped, live
    insert(db, 'tasks', 'TASK-1', 'laptop', 10, null)
    // local-only: never stamped
    insert(db, 'tasks', 'TASK-2', null, null, null)
    // remote-only: authored remotely
    insert(db, 'tasks', 'TASK-3', 'remote', 12, null)
    // tombstoned: deleted wins over origin/stamp
    insert(db, 'tasks', 'TASK-4', 'remote', 9, 15)

    const ledger = computeLedger(db)
    const tasks = ledger.find((r) => r.entity === 'tasks')!
    expect(tasks).toEqual({ entity: 'tasks', inSync: 1, localOnly: 1, remoteOnly: 1, tombstoned: 1 })
    db.close()
  })

  it('returns zeroed buckets for empty tables', () => {
    const db = fixtureDb()
    const ledger = computeLedger(db)
    expect(ledger).toHaveLength(LEDGER_ENTITIES.length)
    for (const row of ledger) {
      expect(row).toMatchObject({ inSync: 0, localOnly: 0, remoteOnly: 0, tombstoned: 0 })
    }
    db.close()
  })

  it('treats a tombstoned local row as tombstoned, not in-sync', () => {
    const db = fixtureDb()
    insert(db, 'inbox_items', 'INBOX-1', 'laptop', 5, 8)
    const inbox = computeLedger(db).find((r) => r.entity === 'inbox')!
    expect(inbox.tombstoned).toBe(1)
    expect(inbox.inSync).toBe(0)
    db.close()
  })
})
