import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import Database from 'better-sqlite3'

import { runImport } from './import-service'
import { runExport } from './export-service'
import { initSchema } from '../domain/repositories/schema'
import { PATHS_MAPPING_VERSION, type PathsMapping } from './paths-mapping'
import type { GitCommands } from './workspace-identity'

let tmp: string
let snapshot: string
let dataDir: string
let db: Database.Database

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'choda-import-'))
  snapshot = path.join(tmp, 'snap')
  dataDir = path.join(tmp, 'data')
  fs.mkdirSync(snapshot)
  fs.mkdirSync(dataDir)
  db = new Database(':memory:')
  initSchema(db)
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const localGit: GitCommands = {
  gitCommonDir: () => null,
  showToplevel: () => null,
  getRemoteOrigin: () => null
}

const FROZEN_NOW = new Date('2026-05-08T00:00:00.000Z')

function emptyMapping(): PathsMapping {
  return { version: PATHS_MAPPING_VERSION, mappings: {} }
}

function seedProject(id: string): void {
  db.prepare('INSERT INTO projects (id, name, cwd) VALUES (?, ?, ?)').run(id, id, '/repo')
  db.prepare('INSERT INTO workspaces (id, project_id, label, cwd) VALUES (?, ?, ?, ?)').run(
    `${id}-main`,
    id,
    'main',
    '/repo'
  )
}

function seedTask(id: string, projectId: string, title: string): void {
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, status, created_at, updated_at)
     VALUES (?, ?, ?, 'TODO', '2026-05-08T00:00:00.000Z', '2026-05-08T00:00:00.000Z')`
  ).run(id, projectId, title)
}

function row<T = Record<string, unknown>>(sql: string, ...args: unknown[]): T | undefined {
  return db.prepare(sql).get(...args) as T | undefined
}

function count(sql: string, ...args: unknown[]): number {
  const r = db.prepare(sql).get(...args) as { c: number } | undefined
  return r?.c ?? 0
}

describe('runImport — AC #4 hydration + scope', () => {
  it('hydrates rows on an empty target', () => {
    const src = new Database(':memory:')
    initSchema(src)
    src.prepare('INSERT INTO projects (id, name, cwd) VALUES (?, ?, ?)').run('p', 'p', '/repo')
    src
      .prepare(
        `INSERT INTO tasks (id, project_id, title, status, created_at, updated_at)
       VALUES ('TASK-001', 'p', 'one', 'TODO', '2026-05-08T00:00:00.000Z', '2026-05-08T00:00:00.000Z')`
      )
      .run()
    runExport({
      outDir: snapshot,
      appVersion: '0.2.0',
      db: src,
      git: localGit,
      now: () => FROZEN_NOW.toISOString()
    })
    src.close()

    const result = runImport({
      snapshotDir: snapshot,
      db,
      pathsMapping: emptyMapping(),
      dataDir,
      now: () => FROZEN_NOW
    })
    expect(result.status).toBe('imported')
    expect(count('SELECT COUNT(*) AS c FROM projects WHERE id = ?', 'p')).toBe(1)
    expect(count('SELECT COUNT(*) AS c FROM tasks WHERE id = ?', 'TASK-001')).toBe(1)
    expect(result.backupPath).not.toBeNull()
    expect(fs.existsSync(result.backupPath!)).toBe(true)
  })

  it('replaces rows for projects in manifest, leaves other projects untouched', () => {
    // Source has only project A with TASK-A1
    const src = new Database(':memory:')
    initSchema(src)
    src.prepare('INSERT INTO projects (id, name, cwd) VALUES (?, ?, ?)').run('A', 'A', '/repo')
    src
      .prepare(
        `INSERT INTO tasks (id, project_id, title, status, created_at, updated_at)
       VALUES ('TASK-A1', 'A', 'a1', 'TODO', '2026-05-08T00:00:00.000Z', '2026-05-08T00:00:00.000Z')`
      )
      .run()
    runExport({
      outDir: snapshot,
      appVersion: '0.2.0',
      db: src,
      projectIds: ['A'],
      git: localGit,
      now: () => FROZEN_NOW.toISOString()
    })
    src.close()

    // Target has projects A (TASK-A0 — will be replaced) and B (TASK-B1 — untouched)
    seedProject('A')
    seedProject('B')
    seedTask('TASK-A0', 'A', 'a0-old')
    seedTask('TASK-B1', 'B', 'b1')

    runImport({
      snapshotDir: snapshot,
      db,
      pathsMapping: emptyMapping(),
      dataDir,
      now: () => FROZEN_NOW
    })

    // Project A: TASK-A0 gone, TASK-A1 hydrated
    expect(count("SELECT COUNT(*) AS c FROM tasks WHERE id = 'TASK-A0'")).toBe(0)
    expect(count("SELECT COUNT(*) AS c FROM tasks WHERE id = 'TASK-A1'")).toBe(1)
    // Project B: untouched
    expect(count("SELECT COUNT(*) AS c FROM tasks WHERE id = 'TASK-B1'")).toBe(1)
    expect(count("SELECT COUNT(*) AS c FROM projects WHERE id = 'B'")).toBe(1)
  })
})

describe('runImport — AC #5 atomicity + backup', () => {
  it('creates pre-import-<ts>.db in <dataDir>/backups/', () => {
    const src = new Database(':memory:')
    initSchema(src)
    src.prepare('INSERT INTO projects (id, name, cwd) VALUES (?, ?, ?)').run('p', 'p', '/repo')
    runExport({
      outDir: snapshot,
      appVersion: '0.2.0',
      db: src,
      git: localGit,
      now: () => FROZEN_NOW.toISOString()
    })
    src.close()

    const result = runImport({
      snapshotDir: snapshot,
      db,
      pathsMapping: emptyMapping(),
      dataDir,
      now: () => FROZEN_NOW
    })
    expect(result.backupPath).not.toBeNull()
    expect(result.backupPath!).toMatch(/pre-import-/)
    expect(fs.existsSync(result.backupPath!)).toBe(true)
    // Distinct filename pattern from rotation backups
    expect(path.basename(result.backupPath!)).not.toMatch(/^choda-deck-\d{4}-\d{2}-\d{2}\.db$/)
  })

  it('rolls back when an INSERT inside the txn throws (DB unchanged)', () => {
    // Build a snapshot whose tasks.json has a duplicate ID inside the same project
    // so the second INSERT raises a UNIQUE-constraint error mid-transaction.
    const src = new Database(':memory:')
    initSchema(src)
    src.prepare('INSERT INTO projects (id, name, cwd) VALUES (?, ?, ?)').run('p', 'p', '/repo')
    runExport({
      outDir: snapshot,
      appVersion: '0.2.0',
      db: src,
      git: localGit,
      now: () => FROZEN_NOW.toISOString()
    })
    src.close()

    // Manually corrupt tasks.json with a duplicate-ID row
    const tasksFile = path.join(snapshot, 'tasks.json')
    const tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8'))
    tasks.rows = [
      {
        id: 'TASK-X',
        project_id: 'p',
        title: 'one',
        status: 'TODO',
        created_at: '2026-05-08T00:00:00.000Z',
        updated_at: '2026-05-08T00:00:00.000Z'
      },
      {
        id: 'TASK-X',
        project_id: 'p',
        title: 'dup',
        status: 'TODO',
        created_at: '2026-05-08T00:00:00.000Z',
        updated_at: '2026-05-08T00:00:00.000Z'
      }
    ]
    fs.writeFileSync(tasksFile, JSON.stringify(tasks), 'utf8')

    seedProject('p')
    seedTask('TASK-OLD', 'p', 'pre-existing')

    expect(() =>
      runImport({
        snapshotDir: snapshot,
        db,
        pathsMapping: emptyMapping(),
        dataDir,
        now: () => FROZEN_NOW
      })
    ).toThrow()

    // Atomicity: TASK-OLD survived because the txn rolled back on duplicate
    expect(count("SELECT COUNT(*) AS c FROM tasks WHERE id = 'TASK-OLD'")).toBe(1)
    expect(count("SELECT COUNT(*) AS c FROM tasks WHERE id = 'TASK-X'")).toBe(0)
  })
})

describe('runImport — AC #6 idempotency', () => {
  it('importing the same snapshot twice produces no row-count drift', () => {
    const src = new Database(':memory:')
    initSchema(src)
    src.prepare('INSERT INTO projects (id, name, cwd) VALUES (?, ?, ?)').run('p', 'p', '/repo')
    src
      .prepare('INSERT INTO workspaces (id, project_id, label, cwd) VALUES (?, ?, ?, ?)')
      .run('w', 'p', 'main', '/repo')
    src
      .prepare(
        `INSERT INTO tasks (id, project_id, title, status, created_at, updated_at)
       VALUES ('TASK-1', 'p', 'one', 'TODO', '2026-05-08T00:00:00.000Z', '2026-05-08T00:00:00.000Z'),
              ('TASK-2', 'p', 'two', 'TODO', '2026-05-08T00:00:00.000Z', '2026-05-08T00:00:00.000Z')`
      )
      .run()
    runExport({
      outDir: snapshot,
      appVersion: '0.2.0',
      db: src,
      git: localGit,
      now: () => FROZEN_NOW.toISOString()
    })
    src.close()

    runImport({
      snapshotDir: snapshot,
      db,
      pathsMapping: emptyMapping(),
      dataDir,
      now: () => FROZEN_NOW
    })
    const after1 = {
      projects: count('SELECT COUNT(*) AS c FROM projects'),
      workspaces: count('SELECT COUNT(*) AS c FROM workspaces'),
      tasks: count('SELECT COUNT(*) AS c FROM tasks')
    }

    runImport({
      snapshotDir: snapshot,
      db,
      pathsMapping: emptyMapping(),
      dataDir,
      now: () => new Date('2026-05-09T00:00:00.000Z')
    })
    const after2 = {
      projects: count('SELECT COUNT(*) AS c FROM projects'),
      workspaces: count('SELECT COUNT(*) AS c FROM workspaces'),
      tasks: count('SELECT COUNT(*) AS c FROM tasks')
    }
    expect(after2).toEqual(after1)
    expect(after1.tasks).toBe(2)
  })
})

describe('runImport — AC #8 dry-run', () => {
  it('runs preflight, returns without writing or backing up', () => {
    const src = new Database(':memory:')
    initSchema(src)
    src.prepare('INSERT INTO projects (id, name, cwd) VALUES (?, ?, ?)').run('p', 'p', '/repo')
    runExport({
      outDir: snapshot,
      appVersion: '0.2.0',
      db: src,
      git: localGit,
      now: () => FROZEN_NOW.toISOString()
    })
    src.close()

    seedProject('p')
    seedTask('TASK-OLD', 'p', 'pre')
    const beforeRows = count('SELECT COUNT(*) AS c FROM tasks')

    const result = runImport({
      snapshotDir: snapshot,
      db,
      pathsMapping: emptyMapping(),
      dataDir,
      dryRun: true,
      now: () => FROZEN_NOW
    })
    expect(result.status).toBe('dry-run')
    expect(result.backupPath).toBeNull()
    expect(count('SELECT COUNT(*) AS c FROM tasks')).toBe(beforeRows)
    expect(fs.existsSync(path.join(dataDir, 'backups'))).toBe(false)
  })

  it('rejects --dry-run + --yes combo', () => {
    expect(() =>
      runImport({
        snapshotDir: snapshot,
        db,
        pathsMapping: emptyMapping(),
        dataDir,
        dryRun: true,
        yes: true,
        now: () => FROZEN_NOW
      })
    ).toThrow(/mutually exclusive/)
  })
})

describe('runImport — AC #11 round-trip via export → import', () => {
  it('round-trips tasks + relationships + tags + conversation messages', () => {
    const src = new Database(':memory:')
    initSchema(src)
    src.prepare('INSERT INTO projects (id, name, cwd) VALUES (?, ?, ?)').run('p', 'p', '/repo')
    src.prepare('INSERT INTO workspaces (id, project_id, label, cwd) VALUES (?, ?, ?, ?)').run(
      'w',
      'p',
      'main',
      '/repo'
    )
    src
      .prepare(
        `INSERT INTO tasks (id, project_id, title, status, created_at, updated_at)
       VALUES ('TASK-1', 'p', 'one', 'TODO', '2026-05-08T00:00:00.000Z', '2026-05-08T00:00:00.000Z'),
              ('TASK-2', 'p', 'two', 'DONE', '2026-05-08T00:00:00.000Z', '2026-05-08T00:00:00.000Z')`
      )
      .run()
    src
      .prepare("INSERT INTO relationships (from_id, to_id, type) VALUES (?, ?, 'DEPENDS_ON')")
      .run('TASK-2', 'TASK-1')
    src.prepare('INSERT INTO tags (item_id, tag) VALUES (?, ?)').run('TASK-1', 'urgent')
    src
      .prepare(
        `INSERT INTO conversations (id, project_id, title, status, created_by)
       VALUES ('CONV-1', 'p', 'first', 'open', 'Butter')`
      )
      .run()
    src
      .prepare(
        `INSERT INTO conversation_messages (id, conversation_id, author_name, content)
       VALUES ('MSG-1', 'CONV-1', 'Butter', 'hello')`
      )
      .run()
    runExport({
      outDir: snapshot,
      appVersion: '0.2.0',
      db: src,
      git: localGit,
      now: () => FROZEN_NOW.toISOString()
    })
    src.close()

    runImport({
      snapshotDir: snapshot,
      db,
      pathsMapping: emptyMapping(),
      dataDir,
      now: () => FROZEN_NOW
    })

    expect(row<{ title: string }>("SELECT title FROM tasks WHERE id = 'TASK-1'")?.title).toBe('one')
    expect(row<{ status: string }>("SELECT status FROM tasks WHERE id = 'TASK-2'")?.status).toBe(
      'DONE'
    )
    expect(
      count(
        "SELECT COUNT(*) AS c FROM relationships WHERE from_id = 'TASK-2' AND to_id = 'TASK-1' AND type = 'DEPENDS_ON'"
      )
    ).toBe(1)
    expect(count("SELECT COUNT(*) AS c FROM tags WHERE item_id = 'TASK-1' AND tag = 'urgent'")).toBe(1)
    expect(count("SELECT COUNT(*) AS c FROM conversations WHERE id = 'CONV-1'")).toBe(1)
    expect(count("SELECT COUNT(*) AS c FROM conversation_messages WHERE id = 'MSG-1'")).toBe(1)
  })
})

describe('runImport — preflight failure', () => {
  it('throws when preflight fails (e.g. unsupported exportFormatVersion)', () => {
    fs.writeFileSync(path.join(snapshot, 'manifest.json'), '{not json', 'utf8')
    expect(() =>
      runImport({
        snapshotDir: snapshot,
        db,
        pathsMapping: emptyMapping(),
        dataDir,
        now: () => FROZEN_NOW
      })
    ).toThrow(/preflight failed/)
  })
})
