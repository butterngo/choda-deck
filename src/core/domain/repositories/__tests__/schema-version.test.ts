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
