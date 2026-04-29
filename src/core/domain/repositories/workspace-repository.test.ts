import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import * as fs from 'fs'
import * as path from 'path'
import { initSchema } from './schema'
import { ProjectRepository } from './project-repository'
import { WorkspaceRepository } from './workspace-repository'

const TEST_DB = path.join(__dirname, '__test-workspace-repo__.db')
let db: Database.Database
let projects: ProjectRepository
let workspaces: WorkspaceRepository

beforeEach(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  db = new Database(TEST_DB)
  initSchema(db)
  projects = new ProjectRepository(db)
  workspaces = new WorkspaceRepository(db)
  projects.ensure('p1', 'Project One', 'C:\\dev\\p1')
})

afterEach(() => {
  db.close()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
})

describe('WorkspaceRepository', () => {
  it('add inserts and returns the row', () => {
    const row = workspaces.add('p1', 'be', 'BE', 'C:\\dev\\p1\\backend')
    expect(row).toEqual({
      id: 'be',
      projectId: 'p1',
      label: 'BE',
      cwd: 'C:\\dev\\p1\\backend',
      archivedAt: null
    })
  })

  it('add upserts on duplicate id', () => {
    workspaces.add('p1', 'be', 'BE', 'C:\\old')
    const updated = workspaces.add('p1', 'be', 'BE2', 'C:\\new')
    expect(updated.label).toBe('BE2')
    expect(updated.cwd).toBe('C:\\new')
    expect(workspaces.findByProject('p1')).toHaveLength(1)
  })

  it('get returns null for missing id', () => {
    expect(workspaces.get('missing')).toBeNull()
  })

  it('get returns the row', () => {
    workspaces.add('p1', 'fe', 'FE', 'C:\\dev\\p1\\frontend')
    const row = workspaces.get('fe')
    expect(row).toEqual({
      id: 'fe',
      projectId: 'p1',
      label: 'FE',
      cwd: 'C:\\dev\\p1\\frontend',
      archivedAt: null
    })
  })

  it('findByProject returns rows ordered by label', () => {
    workspaces.add('p1', 'fe', 'FE', 'C:\\fe')
    workspaces.add('p1', 'be', 'BE', 'C:\\be')
    workspaces.add('p1', 'main', 'AAA-Main', 'C:\\main')
    const rows = workspaces.findByProject('p1')
    expect(rows.map((r) => r.label)).toEqual(['AAA-Main', 'BE', 'FE'])
  })

  it('findByProject returns empty array for unknown project', () => {
    expect(workspaces.findByProject('does-not-exist')).toEqual([])
  })

  it('does not leak rows between projects', () => {
    projects.ensure('p2', 'Project Two', 'C:\\dev\\p2')
    workspaces.add('p1', 'a', 'A', 'C:\\a')
    workspaces.add('p2', 'b', 'B', 'C:\\b')
    expect(workspaces.findByProject('p1').map((r) => r.id)).toEqual(['a'])
    expect(workspaces.findByProject('p2').map((r) => r.id)).toEqual(['b'])
  })

  it('archive sets archived_at and hides from default findByProject', () => {
    workspaces.add('p1', 'a', 'A', 'C:\\a')
    workspaces.add('p1', 'b', 'B', 'C:\\b')
    const archived = workspaces.archive('a')
    expect(archived?.archivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(workspaces.findByProject('p1').map((r) => r.id)).toEqual(['b'])
    expect(workspaces.findByProject('p1', true).map((r) => r.id).sort()).toEqual(['a', 'b'])
  })

  it('archive is idempotent — re-archiving preserves original archivedAt', () => {
    workspaces.add('p1', 'a', 'A', 'C:\\a')
    const first = workspaces.archive('a')
    const firstAt = first?.archivedAt
    const second = workspaces.archive('a')
    expect(second?.archivedAt).toBe(firstAt)
  })

  it('archive returns null for missing workspace', () => {
    expect(workspaces.archive('missing')).toBeNull()
  })

  it('unarchive clears archived_at', () => {
    workspaces.add('p1', 'a', 'A', 'C:\\a')
    workspaces.archive('a')
    const restored = workspaces.unarchive('a')
    expect(restored?.archivedAt).toBeNull()
    expect(workspaces.findByProject('p1').map((r) => r.id)).toEqual(['a'])
  })

  it('delete removes the row', () => {
    workspaces.add('p1', 'a', 'A', 'C:\\a')
    workspaces.delete('a')
    expect(workspaces.get('a')).toBeNull()
  })

  it('countReferences counts sessions referencing the workspace', () => {
    workspaces.add('p1', 'a', 'A', 'C:\\a')
    workspaces.add('p1', 'b', 'B', 'C:\\b')
    db.prepare(
      `INSERT INTO sessions (id, project_id, workspace_id, started_at, status, created_at)
       VALUES (?, 'p1', ?, '2026-04-29', 'completed', '2026-04-29')`
    ).run('S1', 'a')
    db.prepare(
      `INSERT INTO sessions (id, project_id, workspace_id, started_at, status, created_at)
       VALUES (?, 'p1', ?, '2026-04-29', 'active', '2026-04-29')`
    ).run('S2', 'a')
    expect(workspaces.countReferences('a')).toEqual({ sessions: 2 })
    expect(workspaces.countReferences('b')).toEqual({ sessions: 0 })
  })
})
