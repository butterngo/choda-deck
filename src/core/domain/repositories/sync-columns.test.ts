import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { initSchema } from './schema'
import { MIGRATIONS } from './postgres/migrations'
import { SYNCABLE_TABLES, SYNC_COLUMNS, SYNC_COLUMNS_012_TABLES } from '../../sync/syncable-tables'

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
    // 012 covers the tables that existed when it shipped; it has run on live
    // databases and must keep emitting exactly that set.
    for (const table of SYNC_COLUMNS_012_TABLES) {
      for (const col of SYNC_COLUMNS) {
        const stmt = `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col.name} ${col.pgType};`
        expect(sql, stmt).toContain(stmt)
      }
    }
    const addCount = (sql.match(/ADD COLUMN IF NOT EXISTS/g) ?? []).length
    expect(addCount).toBe(SYNC_COLUMNS_012_TABLES.length * SYNC_COLUMNS.length)
  })

  // TASK-2605 — a syncable table added after 012 gets its sync columns from the
  // migration that creates it; together the PG side covers every SYNCABLE_TABLE.
  it('every syncable table outside 012 is created by a later migration with the sync columns', () => {
    const later = SYNCABLE_TABLES.filter((t) => !SYNC_COLUMNS_012_TABLES.includes(t))
    expect(later).toEqual(['deploy_checks'])
    const created = MIGRATIONS.find((m) => m.sql.includes('CREATE TABLE IF NOT EXISTS deploy_checks'))
    expect(created?.name).toBe('019_deploy_checks')
    for (const col of SYNC_COLUMNS) expect(created?.sql).toContain(`${col.name} ${col.pgType}`)
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
