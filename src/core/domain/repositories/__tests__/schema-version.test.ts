import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { initSchema } from '../schema'

let tmpDir: string
let dbPath: string
let db: Database.Database

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-version-'))
  dbPath = path.join(tmpDir, 'test.db')
  db = new Database(dbPath)
})

afterEach(() => {
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function getSchemaVersionRows(): Array<{ version: number }> {
  return db.prepare('SELECT version FROM schema_version').all() as Array<{ version: number }>
}

describe('schema_version', () => {
  it('fresh DB gets a schema_version row with expected value', () => {
    initSchema(db)
    const rows = getSchemaVersionRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].version).toBe(6)
  })

  it('legacy DB without schema_version gets the row after initSchema()', () => {
    // Simulate a legacy DB: create some tables manually without schema_version
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cwd TEXT NOT NULL
      )
    `)
    // Confirm there is no schema_version table yet
    const before = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
      .get()
    expect(before).toBeUndefined()

    initSchema(db)

    const rows = getSchemaVersionRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].version).toBe(6)
  })

  it('running initSchema() twice leaves exactly one row (idempotent)', () => {
    initSchema(db)
    initSchema(db)
    const rows = getSchemaVersionRows()
    expect(rows).toHaveLength(1)
  })
})

// TASK-1516 — initSchema issues ~128 unwrapped db.exec() calls. Under the default
// rollback journal each is its own implicit transaction with two fsyncs and a journal
// file created + deleted, which on NTFS with antivirus made Windows CI time out while
// Linux never did. Measured: 412ms default vs 11ms WAL, a 38.5x gap.
describe('WAL is enabled before the DDL runs (TASK-1516)', () => {
  it('leaves a file-backed database in WAL mode', () => {
    initSchema(db)
    expect(String(db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal')
  })

  it('is the reason a fresh initSchema is fast — regression guard on the timing', () => {
    // Not a benchmark: the threshold is deliberately loose (10x the measured WAL median,
    // still 4x under the rollback-journal median) so it fires on a genuine regression to
    // non-WAL without flaking on a slow machine. Without WAL this takes ~412ms locally
    // and far longer on a contended CI runner.
    const t0 = process.hrtime.bigint()
    initSchema(db)
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    expect(ms).toBeLessThan(100)
  })

  it('does not throw on an in-memory database, which cannot use WAL', () => {
    // SQLite returns the unchanged mode rather than raising; the same graceful path
    // covers a cross-mount deployment where WAL is refused (TASK-780).
    const mem = new Database(':memory:')
    expect(() => initSchema(mem)).not.toThrow()
    expect(String(mem.pragma('journal_mode', { simple: true })).toLowerCase()).not.toBe('wal')
    mem.close()
  })
})
