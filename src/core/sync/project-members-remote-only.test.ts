// TASK-2243 AC-2 / TASK-2253 AC-1 — project_members is remote-only: it must
// never become a syncable table. Since TASK-2253 the SQLite schema creates it
// too (the live remote runs SQLite); a laptop just carries it empty.

import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initSchema } from '../domain/repositories/schema'
import { SYNCABLE_TABLES } from './syncable-tables'

describe('TASK-2243 — project_members stays remote-only', () => {
  it('is not in SYNCABLE_TABLES', () => {
    expect(SYNCABLE_TABLES).not.toContain('project_members')
  })

  it('TASK-2253 AC-1: is created by the SQLite schema (for the SQLite-backed remote)', () => {
    const db = new Database(':memory:')
    try {
      initSchema(db)
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_members'")
        .get()
      expect(row).toEqual({ name: 'project_members' })
    } finally {
      db.close()
    }
  })
})
