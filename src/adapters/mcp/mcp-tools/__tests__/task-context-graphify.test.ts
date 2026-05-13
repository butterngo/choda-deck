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
    getProject: () =>
      projectCwd ? { id: 'proj-test', name: 'test', cwd: projectCwd } : null,
    listProjects: () => [],
    addWorkspace: () => ({ id: '', projectId: '', label: '', cwd: '', archivedAt: null }),
    getWorkspace: () => null,
    findWorkspaces: () =>
      workspaceCwds.map((cwd, i) => ({
        id: `ws-${i}`,
        projectId: 'proj-test',
        label: `ws${i}`,
        cwd,
        archivedAt: null
      })),
    archiveWorkspace: () => null,
    unarchiveWorkspace: () => null
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
        { id: 'auth_logout', label: 'AuthService.logout', source_file: 'src/auth.ts', community: 0 },
        { id: 'db_conn', label: 'DbConnection', source_file: 'src/db.ts', community: 1 },
        { id: 'unrelated', label: 'Unrelated', source_file: 'src/other.ts', community: 2 }
      ],
      [
        { source: 'auth_service', target: 'auth_login', relation: 'method', confidence_score: 1.0 },
        { source: 'auth_service', target: 'auth_logout', relation: 'method', confidence_score: 1.0 },
        { source: 'auth_service', target: 'db_conn', relation: 'calls', confidence_score: 0.9 },
        { source: 'auth_service', target: 'db_conn', relation: 'imports_from', confidence_score: 1.0 },
        { source: 'auth_service', target: 'db_conn', relation: 'contains', confidence_score: 1.0 },
        { source: 'auth_service', target: 'db_conn', relation: 'references', confidence_score: 1.0 },
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
    writeFixtureGraph(
      tmp,
      [{ id: 'foo', label: 'RendererStuff', source_file: 'x.ts' }],
      []
    )
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

  it('uses ## File Pointers paths to find start nodes (trust body author over keyword match)', () => {
    writeFixtureGraph(
      tmp,
      [
        { id: 'target_class', label: 'TargetClass', source_file: 'src/target.ts' },
        { id: 'target_method', label: 'TargetClass.run', source_file: 'src/target.ts' },
        { id: 'noisy_match', label: 'RefactorService', source_file: 'src/noisy.ts' }
      ],
      [{ source: 'target_class', target: 'target_method', relation: 'method', confidence_score: 1.0 }]
    )
    const task = makeTask({
      title: 'refactor',
      body: '## File Pointers\n\n- `src/target.ts` — actual edit target\n- `src/new-file.ts` (NEW) — should be skipped\n\n## Acceptance\n- [ ] do thing\n'
    })
    const result = buildGraphifyContext(task, makeDeps([tmp]))
    if ('affected_files' in result) {
      expect(result.affected_files[0]?.path).toBe('src/target.ts')
      const paths = result.affected_files.map((f) => f.path)
      expect(paths).not.toContain('src/noisy.ts')
    } else {
      throw new Error('expected affected_files result')
    }
  })

  it('extractAcceptanceSection ignores `## Acceptance` mentions inside prose (only matches real heading)', () => {
    writeFixtureGraph(
      tmp,
      [
        { id: 'real_target', label: 'RealTarget', source_file: 'src/real.ts' },
        { id: 'noise_node', label: 'NoiseWord', source_file: 'src/noise.ts' }
      ],
      []
    )
    const task = makeTask({
      title: 'work',
      body:
        '## Context\n\n' +
        'The `## Acceptance` template enforces noise across all tasks.\n\n' +
        '## Acceptance\n\n' +
        '- [ ] verify realtarget behavior\n'
    })
    const result = buildGraphifyContext(task, makeDeps([tmp]))
    if ('affected_files' in result) {
      expect(result.keywords_used).toContain('realtarget')
      expect(result.keywords_used).not.toContain('noise')
    } else {
      throw new Error('expected affected_files result')
    }
  })

  it('extractFilePointers ignores `## File Pointers` mentions inside prose (only matches real heading)', () => {
    writeFixtureGraph(
      tmp,
      [
        { id: 'real_target', label: 'RealTarget', source_file: 'src/real.ts' },
        { id: 'noisy', label: 'NoisyMatch', source_file: 'src/noisy.ts' }
      ],
      []
    )
    const task = makeTask({
      title: 'refactor',
      body:
        '## Context\n\n' +
        'The `## File Pointers` section in body must be parsed correctly even when it appears inside prose like this.\n\n' +
        '## File Pointers\n\n' +
        '- `src/real.ts` — actual target\n\n' +
        '## Acceptance\n- [ ] do thing\n'
    })
    const result = buildGraphifyContext(task, makeDeps([tmp]))
    if ('affected_files' in result) {
      expect(result.affected_files[0]?.path).toBe('src/real.ts')
      expect(result.affected_files.map((f) => f.path)).not.toContain('src/noisy.ts')
    } else {
      throw new Error('expected affected_files result')
    }
  })

  it('drops label keys (assignee:, adr-, phase-) and exact label drops (auto-safe, bug, ...) from keywords', () => {
    writeFixtureGraph(
      tmp,
      [{ id: 'graphify_node', label: 'GraphifyHelper', source_file: 'g.ts' }],
      []
    )
    const task = makeTask({
      title: 'graphify pipeline',
      labels: ['assignee:butter', 'adr-019', 'phase-2', 'auto-safe', 'bug', 'graphify']
    })
    const result = buildGraphifyContext(task, makeDeps([tmp]))
    if ('affected_files' in result) {
      expect(result.keywords_used).not.toContain('assignee:butter')
      expect(result.keywords_used).not.toContain('adr-019')
      expect(result.keywords_used).not.toContain('phase-2')
      expect(result.keywords_used).not.toContain('auto-safe')
      expect(result.keywords_used).not.toContain('bug')
      expect(result.keywords_used).toContain('graphify')
    } else {
      throw new Error('expected affected_files result')
    }
  })

  it('filters Vietnamese stopwords (>3 chars) from keywords', () => {
    writeFixtureGraph(
      tmp,
      [{ id: 'graph_helper', label: 'GraphHelper', source_file: 'g.ts' }],
      []
    )
    const task = makeTask({
      title: 'graph trong không chứa theo'
    })
    const result = buildGraphifyContext(task, makeDeps([tmp]))
    if ('affected_files' in result) {
      expect(result.keywords_used).toContain('graph')
      expect(result.keywords_used).not.toContain('trong')
      expect(result.keywords_used).not.toContain('không')
      expect(result.keywords_used).not.toContain('chứa')
      expect(result.keywords_used).not.toContain('theo')
    } else {
      throw new Error('expected affected_files result')
    }
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
