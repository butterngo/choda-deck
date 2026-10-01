// TASK-2243 AC-2 — project_members is remote-only: it must never become a
// syncable table and never appear in the SQLite schema.

import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initSchema } from '../domain/repositories/schema'
import { SYNCABLE_TABLES } from './syncable-tables'

describe('TASK-2243 — project_members stays remote-only', () => {
  it('is not in SYNCABLE_TABLES', () => {
    expect(SYNCABLE_TABLES).not.toContain('project_members')
  })

  it('is not created by the SQLite schema', () => {
    const db = new Database(':memory:')
    try {
      initSchema(db)
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_members'")
        .get()
      expect(row).toBeUndefined()
    } finally {
      db.close()
    }
  })
})
