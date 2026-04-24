import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { buildGraphifyContext, type GraphifyDeps } from '../task-context-graphify'
import type { Task } from '../../../../core/domain/task-types'

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'TASK-999',
    projectId: 'proj-test',
    phaseId: null,
    parentTaskId: null,
    title: 'test task',
    status: 'TODO',
    priority: null,
    labels: [],
    dueDate: null,
    pinned: false,
    filePath: null,
    body: null,
    createdAt: '2026-04-24T00:00:00Z',
    updatedAt: '2026-04-24T00:00:00Z',
    ...overrides
  }
}

function makeDeps(workspaceCwds: string[] = [], projectCwd: string | null = null): GraphifyDeps {
  return {
    ensureProject: () => {},
    getProject: () => (projectCwd ? { id: 'proj-test', name: 'test', cwd: projectCwd } : null),
    listProjects: () => [],
    addWorkspace: () => ({ id: '', projectId: '', label: '', cwd: '' }),
    getWorkspace: () => null,
    findWorkspaces: () =>
      workspaceCwds.map((cwd, i) => ({
        id: `ws-${i}`,
        projectId: 'proj-test',
        label: `ws${i}`,
        cwd
      }))
  }
}

function writeFixtureGraph(dir: string, nodes: unknown[], links: unknown[]): string {
  const out = path.join(dir, 'graphify-out')
  fs.mkdirSync(out, { recursive: true })
  const p = path.join(out, 'graph.json')
  fs.writeFileSync(p, JSON.stringify({ nodes, links }))
  return p
}

describe('buildGraphifyContext', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'graphify-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('returns no-graph when graphify-out is absent', () => {
    const task = makeTask({ title: 'anything' })
    const result = buildGraphifyContext(task, makeDeps([tmp]))
    expect(result).toHaveProperty('status', 'no-graph')
  })

  it('returns no-matches when keywords are empty', () => {
    writeFixtureGraph(tmp, [], [])
    const task = makeTask({ title: 'a b' }) // all tokens too short
    const result = buildGraphifyContext(task, makeDeps([tmp]))
    expect(result).toHaveProperty('status', 'no-matches')
  })

  it('returns affected_files + god_nodes + staleness when a match exists', () => {
    writeFixtureGraph(
      tmp,
      [
        { id: 'auth_service', label: 'AuthService', source_file: 'src/auth.ts', community: 0 },
        { id: 'auth_login', label: 'AuthService.login', source_file: 'src/auth.ts', community: 0 },
        {
          id: 'auth_logout',
          label: 'AuthService.logout',
          source_file: 'src/auth.ts',
          community: 0
        },
        { id: 'db_conn', label: 'DbConnection', source_file: 'src/db.ts', community: 1 },
        { id: 'unrelated', label: 'Unrelated', source_file: 'src/other.ts', community: 2 }
      ],
      [
        { source: 'auth_service', target: 'auth_login', relation: 'method', confidence_score: 1.0 },
        {
          source: 'auth_service',
          target: 'auth_logout',
          relation: 'method',
          confidence_score: 1.0
        },
        { source: 'auth_service', target: 'db_conn', relation: 'calls', confidence_score: 0.9 },
        {
          source: 'auth_service',
          target: 'db_conn',
          relation: 'imports_from',
          confidence_score: 1.0
        },
        { source: 'auth_service', target: 'db_conn', relation: 'contains', confidence_score: 1.0 },
        {
          source: 'auth_service',
          target: 'db_conn',
          relation: 'references',
          confidence_score: 1.0
        },
        { source: 'auth_service', target: 'db_conn', relation: 'implements', confidence_score: 1.0 }
      ]
    )
    const task = makeTask({ title: 'refactor authservice login flow' })
    const result = buildGraphifyContext(task, makeDeps([tmp]))
    expect(result).not.toHaveProperty('status')
    if ('affected_files' in result) {
      expect(result.affected_files.length).toBeGreaterThan(0)
      expect(result.affected_files.map((f) => f.path)).toContain('src/auth.ts')
      expect(result.keywords_used).toContain('authservice')
      expect(result.god_nodes[0]?.id).toBe('auth_service')
      expect(result.affected_communities.length).toBeGreaterThan(0)
      expect(typeof result.graph_age_days).toBe('number')
      expect(result.graph_is_stale).toBe(false)
      expect(result.graph_mtime_iso).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    }
  })

  it('filters out edges below confidence threshold', () => {
    writeFixtureGraph(
      tmp,
      [
        { id: 'a', label: 'TaskAlpha', source_file: 'a.ts' },
        { id: 'b', label: 'NodeB', source_file: 'b.ts' }
      ],
      [{ source: 'a', target: 'b', relation: 'calls', confidence_score: 0.5 }]
    )
    const task = makeTask({ title: 'work on taskalpha' })
    const result = buildGraphifyContext(task, makeDeps([tmp]))
    if ('affected_files' in result) {
      const paths = result.affected_files.map((f) => f.path)
      expect(paths).not.toContain('b.ts')
    } else {
      throw new Error('expected affected_files result')
    }
  })

  it('filters out edges with non-allowed relations', () => {
    writeFixtureGraph(
      tmp,
      [
        { id: 'a', label: 'TaskAlpha', source_file: 'a.ts' },
        { id: 'b', label: 'NodeB', source_file: 'b.ts' }
      ],
      [{ source: 'a', target: 'b', relation: 'semantically_similar_to', confidence_score: 1.0 }]
    )
    const task = makeTask({ title: 'work on taskalpha' })
    const result = buildGraphifyContext(task, makeDeps([tmp]))
    if ('affected_files' in result) {
      const paths = result.affected_files.map((f) => f.path)
      expect(paths).not.toContain('b.ts')
    } else {
      throw new Error('expected affected_files result')
    }
  })

  it('boosts keywords from labels', () => {
    writeFixtureGraph(tmp, [{ id: 'foo', label: 'RendererStuff', source_file: 'x.ts' }], [])
    const task = makeTask({ title: 'abc', labels: ['rendererstuff'] })
    const result = buildGraphifyContext(task, makeDeps([tmp]))
    if ('affected_files' in result) {
      expect(result.keywords_used).toContain('rendererstuff')
    }
  })

  it('falls back to project cwd if workspaces have no graph', () => {
    writeFixtureGraph(tmp, [{ id: 'n', label: 'TaskAlpha', source_file: 'x.ts' }], [])
    const task = makeTask({ title: 'taskalpha matter' })
    const result = buildGraphifyContext(task, makeDeps([], tmp))
    expect(result).not.toHaveProperty('status')
  })

  it('writes a usage.log entry on successful query', () => {
    writeFixtureGraph(tmp, [{ id: 'taskalpha', label: 'TaskAlpha', source_file: 'a.ts' }], [])
    const task = makeTask({ title: 'work on taskalpha feature' })
    buildGraphifyContext(task, makeDeps([tmp]))
    const logPath = path.join(tmp, 'graphify-out', 'usage.log')
    expect(fs.existsSync(logPath)).toBe(true)
    const content = fs.readFileSync(logPath, 'utf8')
    const parts = content.trim().split('\t')
    expect(parts[1]).toBe('TASK-999')
    expect(Number(parts[2])).toBeGreaterThan(0) // keywordsCount
    expect(Number(parts[3])).toBeGreaterThan(0) // subgraphSize
  })

  it('does not write usage.log on no-graph or no-matches', () => {
    const task = makeTask({ title: 'anything here' })
    buildGraphifyContext(task, makeDeps([tmp])) // no-graph
    const logPath = path.join(tmp, 'graphify-out', 'usage.log')
    expect(fs.existsSync(logPath)).toBe(false)
  })

  it('marks stale when file is older than 7 days', () => {
    const graphPath = writeFixtureGraph(
      tmp,
      [{ id: 'n', label: 'TaskAlpha', source_file: 'x.ts' }],
      []
    )
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000
    fs.utimesSync(graphPath, new Date(eightDaysAgo), new Date(eightDaysAgo))
    const task = makeTask({ title: 'taskalpha matter' })
    const result = buildGraphifyContext(task, makeDeps([tmp]))
    if ('affected_files' in result) {
      expect(result.graph_is_stale).toBe(true)
      expect(result.graph_age_days).toBeGreaterThan(7)
    } else {
      throw new Error('expected affected_files result')
    }
  })
})
