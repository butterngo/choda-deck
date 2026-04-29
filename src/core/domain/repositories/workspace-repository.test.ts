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
      cwd: 'C:\\dev\\p1\\backend'
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
      cwd: 'C:\\dev\\p1\\frontend'
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
})
