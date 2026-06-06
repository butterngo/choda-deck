import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { initSchema } from './schema'
import { MIGRATIONS } from './postgres/migrations'
import { SYNCABLE_TABLES, SYNC_COLUMNS } from '../../sync/syncable-tables'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  initSchema(db)
})

afterEach(() => {
  db.close()
})

function colNames(table: string): string[] {
  const rows = db.pragma(`table_info(${table})`) as Array<{ name: string }>
  return rows.map((r) => r.name)
}

describe('ADR-030 Phase 1 — sync columns (SQLite)', () => {
  it('every syncable table carries all sync columns', () => {
    for (const table of SYNCABLE_TABLES) {
      const cols = colNames(table)
      for (const col of SYNC_COLUMNS) {
        expect(cols, `${table}.${col.name}`).toContain(col.name)
      }
    }
  })

  it('migration is idempotent — re-running initSchema does not duplicate columns', () => {
    initSchema(db)
    initSchema(db)
    for (const table of SYNCABLE_TABLES) {
      const cols = colNames(table)
      for (const col of SYNC_COLUMNS) {
        expect(cols.filter((c) => c === col.name), `${table}.${col.name}`).toHaveLength(1)
      }
    }
  })

  it('creates the _sync_clock and _sync_state singletons', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '\\_sync\\_%' ESCAPE '\\'")
      .all() as Array<{ name: string }>
    const names = tables.map((t) => t.name)
    expect(names).toContain('_sync_clock')
    expect(names).toContain('_sync_state')
  })
})

describe('ADR-030 Phase 1 — schema parity (SQLite ↔ Postgres)', () => {
  // No live Postgres needed: both backends generate their ALTERs from the same
  // SYNCABLE_TABLES × SYNC_COLUMNS lists, so verifying the PG migration emits one
  // ADD COLUMN per (table, column) proves the column set matches the SQLite side.
  it('the 012_sync_columns PG migration covers the identical (table, column) set', () => {
    const migration = MIGRATIONS.find((m) => m.name === '012_sync_columns')
    expect(migration, '012_sync_columns migration present').toBeDefined()
    const sql = migration!.sql
    for (const table of SYNCABLE_TABLES) {
      for (const col of SYNC_COLUMNS) {
        const stmt = `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col.name} ${col.pgType};`
        expect(sql, stmt).toContain(stmt)
      }
    }
    // No extra ADD COLUMN statements beyond the shared set.
    const addCount = (sql.match(/ADD COLUMN IF NOT EXISTS/g) ?? []).length
    expect(addCount).toBe(SYNCABLE_TABLES.length * SYNC_COLUMNS.length)
  })

  it('SYNCABLE_TABLES is non-empty and the tables exist in SQLite', () => {
    expect(SYNCABLE_TABLES.length).toBeGreaterThan(0)
    const live = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>
    const liveNames = new Set(live.map((t) => t.name))
    for (const table of SYNCABLE_TABLES) {
      expect(liveNames, table).toContain(table)
    }
  })
})
