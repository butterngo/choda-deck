import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import * as fs from 'fs'
import * as path from 'path'
import { initSchema } from './schema'
import { ProjectRepository, PROJECT_OWNED_TABLES } from './project-repository'
import { WorkspaceRepository } from './workspace-repository'

// TASK-2200 — project org + project removal.

const TEST_DB = path.join(__dirname, '__test-project-repo__.db')
let db: Database.Database
let projects: ProjectRepository
let workspaces: WorkspaceRepository

beforeEach(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  db = new Database(TEST_DB)
  initSchema(db)
  projects = new ProjectRepository(db)
  workspaces = new WorkspaceRepository(db)
})

afterEach(() => {
  db.close()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
})

function insertTask(projectId: string): void {
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO tasks (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(`TASK-${projectId}`, projectId, 'a task', now, now)
}

describe('schema migration — projects.org', () => {
  it('adds a nullable org to a pre-migration projects table and leaves existing rows intact', () => {
    db.close()
    fs.unlinkSync(TEST_DB)
    db = new Database(TEST_DB)
    db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT NOT NULL)')
    db.prepare('INSERT INTO projects VALUES (?, ?, ?)').run('old', 'Old Project', 'C:\\dev\\old')

    initSchema(db)

    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get('old') as Record<string, unknown>
    expect(row.id).toBe('old')
    expect(row.name).toBe('Old Project')
    expect(row.cwd).toBe('C:\\dev\\old')
    expect(row.org).toBeNull()
  })

  it('is idempotent when the column already exists', () => {
    expect(() => initSchema(db)).not.toThrow()
  })
})

describe('ProjectRepository — org', () => {
  it('ensure stores org and get/list return it', () => {
    projects.ensure('a', 'A', 'C:\\a', 'ichiba')
    projects.ensure('b', 'B', 'C:\\b')
    expect(projects.get('a')).toEqual({ id: 'a', name: 'A', cwd: 'C:\\a', org: 'ichiba' })
    expect(projects.get('b')?.org).toBeNull()
    expect(projects.list().map((p) => [p.id, p.org])).toEqual([
      ['a', 'ichiba'],
      ['b', null]
    ])
  })

  it('list(org) returns only that org and excludes projects with no org', () => {
    projects.ensure('a', 'A', 'C:\\a', 'ichiba')
    projects.ensure('b', 'B', 'C:\\b', 'mantu')
    projects.ensure('c', 'C', 'C:\\c')
    expect(projects.list('ichiba').map((p) => p.id)).toEqual(['a'])
    expect(projects.list('mantu').map((p) => p.id)).toEqual(['b'])
    expect(projects.list('nobody')).toEqual([])
  })

  it('ensure without org does not clear an org already set', () => {
    projects.ensure('a', 'A', 'C:\\a', 'ichiba')
    projects.ensure('a', 'A', 'C:\\a')
    expect(projects.get('a')?.org).toBe('ichiba')
  })

  it('ensure sets org on an existing project, and null clears it', () => {
    projects.ensure('a', 'A', 'C:\\a')
    projects.ensure('a', 'A', 'C:\\a', 'jsp')
    expect(projects.get('a')?.org).toBe('jsp')
    projects.ensure('a', 'A', 'C:\\a', null)
    expect(projects.get('a')?.org).toBeNull()
  })

  it('ensure still leaves name and cwd of an existing project unchanged', () => {
    projects.ensure('a', 'A', 'C:\\a')
    projects.ensure('a', 'Renamed', 'C:\\elsewhere', 'ichiba')
    expect(projects.get('a')).toEqual({ id: 'a', name: 'A', cwd: 'C:\\a', org: 'ichiba' })
  })
})

describe('ProjectRepository — remove', () => {
  it('removes an unused project together with its workspaces', () => {
    projects.ensure('empty', 'Empty', 'C:\\empty')
    workspaces.add('empty', 'ws1', 'WS', 'C:\\empty\\ws')
    expect(projects.remove('empty')).toEqual({ removed: true, workspacesRemoved: 1 })
    expect(projects.get('empty')).toBeNull()
    expect(workspaces.findByProject('empty', true)).toEqual([])
  })

  it('refuses a project that owns a task, names the blocker and deletes nothing', () => {
    projects.ensure('busy', 'Busy', 'C:\\busy')
    workspaces.add('busy', 'ws2', 'WS', 'C:\\busy\\ws')
    insertTask('busy')

    expect(projects.remove('busy')).toEqual({
      removed: false,
      reason: 'in-use',
      blockers: { tasks: 1 }
    })
    expect(projects.get('busy')).not.toBeNull()
    expect(workspaces.findByProject('busy')).toHaveLength(1)
  })

  it('reports not-found for an unknown project', () => {
    expect(projects.remove('ghost')).toEqual({ removed: false, reason: 'not-found' })
  })

  it('every blocker table exists and has a project_id column', () => {
    for (const table of PROJECT_OWNED_TABLES) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      expect(cols.map((c) => c.name), table).toContain('project_id')
    }
  })
})
