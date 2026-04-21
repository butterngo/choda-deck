import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import * as fs from 'fs'
import * as path from 'path'
import { initSchema } from './schema'

const TEST_DB = path.join(__dirname, '__test-schema__.db')
let db: Database.Database

beforeEach(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  db = new Database(TEST_DB)
  initSchema(db)
})

afterEach(() => {
  db.close()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
})

function getCounter(entity: string): number {
  const row = db
    .prepare('SELECT last_number FROM global_counters WHERE entity_type = ?')
    .get(entity) as { last_number: number } | undefined
  return row?.last_number ?? -1
}

function insertTask(id: string): void {
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, status, created_at, updated_at)
     VALUES (?, 'p', 't', 'TODO', '2026-01-01', '2026-01-01')`
  ).run(id)
}

describe('seedGlobalCounter', () => {
  it('seeds counter to max of sane IDs', () => {
    insertTask('TASK-005')
    insertTask('TASK-042')
    insertTask('TASK-100')
    initSchema(db)
    expect(getCounter('task')).toBe(100)
  })

  it('ignores legacy timestamp-style IDs when computing max', () => {
    insertTask('TASK-042')
    insertTask('TASK-1776417858921')
    initSchema(db)
    // Seed picks max=42 from sane IDs only; cleanupPoisonedTaskIds then renames
    // the legacy row to TASK-043, bumping the counter by one so future inserts
    // can't collide with the rename output.
    expect(getCounter('task')).toBe(43)
  })

  it('resets poisoned counter back down to sane max', () => {
    insertTask('TASK-042')
    db.prepare(
      "UPDATE global_counters SET last_number = 1776417858921 WHERE entity_type = 'task'"
    ).run()
    expect(getCounter('task')).toBe(1776417858921)
    initSchema(db)
    expect(getCounter('task')).toBe(42)
  })

  it('preserves counter above sane-max IDs in DB (never moves backward)', () => {
    insertTask('TASK-005')
    insertTask('TASK-042')
    db.prepare("UPDATE global_counters SET last_number = 100 WHERE entity_type = 'task'").run()
    initSchema(db)
    expect(getCounter('task')).toBe(100)
  })

  it('handles empty DB — counter stays at 0', () => {
    initSchema(db)
    expect(getCounter('task')).toBe(0)
  })
})

describe('cleanupPoisonedTaskIds', () => {
  it('renames timestamp-style task IDs to sequential', () => {
    insertTask('TASK-042')
    insertTask('TASK-1776417858921')
    insertTask('TASK-1776417858922')
    initSchema(db)
    const ids = db
      .prepare("SELECT id FROM tasks WHERE id GLOB 'TASK-[0-9]*' ORDER BY id")
      .all() as Array<{ id: string }>
    expect(ids.map((r) => r.id)).toEqual(['TASK-042', 'TASK-043', 'TASK-044'])
  })

  it('updates referring rows in sessions.task_id', () => {
    db.prepare("INSERT INTO projects (id, name, cwd) VALUES ('p', 'p', 'p')").run()
    insertTask('TASK-1776417858921')
    db.prepare(
      `INSERT INTO sessions (id, project_id, task_id, started_at, status, created_at)
       VALUES ('s1', 'p', 'TASK-1776417858921', '2026-01-01', 'active', '2026-01-01')`
    ).run()
    initSchema(db)
    const row = db.prepare("SELECT task_id FROM sessions WHERE id = 's1'").get() as {
      task_id: string
    }
    expect(row.task_id).toBe('TASK-001')
  })

  it('updates parent_task_id self-reference', () => {
    insertTask('TASK-1776417858921')
    insertTask('TASK-1776417858922')
    db.prepare(
      "UPDATE tasks SET parent_task_id = 'TASK-1776417858921' WHERE id = 'TASK-1776417858922'"
    ).run()
    initSchema(db)
    const rows = db.prepare('SELECT id, parent_task_id FROM tasks ORDER BY id').all() as Array<{
      id: string
      parent_task_id: string | null
    }>
    const child = rows.find((r) => r.parent_task_id !== null)
    const parent = rows.find((r) => r.parent_task_id === null)
    expect(parent).toBeDefined()
    expect(child!.parent_task_id).toBe(parent!.id)
  })

  it('is idempotent — no-op when no poisoned IDs', () => {
    insertTask('TASK-001')
    initSchema(db)
    initSchema(db)
    const ids = db.prepare('SELECT id FROM tasks').all() as Array<{ id: string }>
    expect(ids).toHaveLength(1)
    expect(ids[0].id).toBe('TASK-001')
  })
})

describe('M1 schema migrations', () => {
  function colNames(table: string): string[] {
    const rows = db.pragma(`table_info(${table})`) as Array<{ name: string }>
    return rows.map((r) => r.name)
  }

  it('adds owner attribution columns to conversations', () => {
    const cols = colNames('conversations')
    expect(cols).toContain('owner_session_id')
    expect(cols).toContain('owner_type')
  })

  it('creates idx_conversations_owner_session index', () => {
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_conversations_owner_session'"
      )
      .get()
    expect(idx).toBeDefined()
  })

  it('migration is idempotent — initSchema can run multiple times', () => {
    initSchema(db)
    initSchema(db)
    initSchema(db)
    const cols = colNames('sessions')
    expect(cols.filter((c) => c === 'checkpoint')).toHaveLength(1)
  })
})
