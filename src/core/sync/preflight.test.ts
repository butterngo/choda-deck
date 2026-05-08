import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import Database from 'better-sqlite3'

import { runPreflight, formatPreflightSummary, MAX_IDS_PER_TABLE } from './preflight'
import { initSchema } from '../domain/repositories/schema'
import { canonicalJson } from './canonical-json'
import { EXPORT_FORMAT_VERSION, type SnapshotManifest } from './snapshot-types'
import { PATHS_MAPPING_VERSION, type PathsMapping } from './paths-mapping'

let tmp: string
let snapshot: string
let db: Database.Database

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'choda-preflight-'))
  snapshot = path.join(tmp, 'snap')
  fs.mkdirSync(snapshot)
  db = new Database(':memory:')
  initSchema(db)
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

interface SnapshotInput {
  projectIds: string[]
  manifest?: Partial<SnapshotManifest>
  projects?: Array<{ id: string; name: string; cwd: string }>
  workspaces?: Array<{ id: string; project_id: string; label: string; cwd: string }>
  tasks?: Array<Record<string, unknown>>
  conversations?: Array<Record<string, unknown>>
  inbox?: Array<Record<string, unknown>>
  sessions?: Array<Record<string, unknown>>
  knowledge?: Array<Record<string, unknown>>
}

function writeSnapshot(input: SnapshotInput): void {
  const baseManifest: SnapshotManifest = {
    exportFormatVersion: EXPORT_FORMAT_VERSION,
    appVersion: '0.2.0',
    exportedAt: '2026-05-08T00:00:00.000Z',
    contentHash: 'a'.repeat(64),
    projectIds: input.projectIds,
    workspaceIdentities: [],
    includesArtifacts: false
  }
  const manifest = { ...baseManifest, ...input.manifest }
  fs.writeFileSync(path.join(snapshot, 'manifest.json'), canonicalJson(manifest), 'utf8')
  fs.writeFileSync(
    path.join(snapshot, 'projects.json'),
    canonicalJson({ rows: input.projects ?? [] }),
    'utf8'
  )
  fs.writeFileSync(
    path.join(snapshot, 'workspaces.json'),
    canonicalJson({ rows: input.workspaces ?? [] }),
    'utf8'
  )
  fs.writeFileSync(
    path.join(snapshot, 'tasks.json'),
    canonicalJson({ rows: input.tasks ?? [], tags: [], relationships: [] }),
    'utf8'
  )
  fs.writeFileSync(
    path.join(snapshot, 'conversations.json'),
    canonicalJson({
      rows: input.conversations ?? [],
      messages: [],
      actions: [],
      links: [],
      participants: []
    }),
    'utf8'
  )
  fs.writeFileSync(
    path.join(snapshot, 'inbox.json'),
    canonicalJson({ rows: input.inbox ?? [] }),
    'utf8'
  )
  fs.writeFileSync(
    path.join(snapshot, 'sessions.json'),
    canonicalJson({ rows: input.sessions ?? [] }),
    'utf8'
  )
  fs.writeFileSync(
    path.join(snapshot, 'knowledge.json'),
    canonicalJson({ rows: input.knowledge ?? [] }),
    'utf8'
  )
}

function emptyMapping(): PathsMapping {
  return { version: PATHS_MAPPING_VERSION, mappings: {} }
}

function seedTask(id: string, projectId: string): void {
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, status, created_at, updated_at)
     VALUES (?, ?, ?, 'TODO', '2026-05-08T00:00:00.000Z', '2026-05-08T00:00:00.000Z')`
  ).run(id, projectId, `t-${id}`)
}

describe('runPreflight — manifest validation', () => {
  it('errors when manifest.json is missing', () => {
    const r = runPreflight({ snapshotDir: snapshot, db, pathsMapping: emptyMapping(), yes: false })
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toMatch(/manifest\.json not found/)
  })

  it('errors when manifest.json is malformed', () => {
    fs.writeFileSync(path.join(snapshot, 'manifest.json'), '{not json', 'utf8')
    const r = runPreflight({ snapshotDir: snapshot, db, pathsMapping: emptyMapping(), yes: false })
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toMatch(/not valid JSON/)
  })

  it('errors on unsupported exportFormatVersion', () => {
    writeSnapshot({ projectIds: ['p'], manifest: { exportFormatVersion: 99 } })
    const r = runPreflight({ snapshotDir: snapshot, db, pathsMapping: emptyMapping(), yes: false })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => /unsupported exportFormatVersion 99/.test(e))).toBe(true)
  })

  it('errors when a domain file is missing', () => {
    writeSnapshot({ projectIds: ['p'] })
    fs.unlinkSync(path.join(snapshot, 'tasks.json'))
    const r = runPreflight({ snapshotDir: snapshot, db, pathsMapping: emptyMapping(), yes: false })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => /missing snapshot file: tasks\.json/.test(e))).toBe(true)
  })

  it('passes on a valid empty snapshot', () => {
    writeSnapshot({ projectIds: [] })
    const r = runPreflight({ snapshotDir: snapshot, db, pathsMapping: emptyMapping(), yes: false })
    expect(r.ok).toBe(true)
    expect(r.errors).toEqual([])
    expect(r.manifest).not.toBeNull()
  })
})

describe('runPreflight — missing path mappings', () => {
  it('warns (does not block) when --yes is false', () => {
    writeSnapshot({
      projectIds: ['p'],
      manifest: {
        workspaceIdentities: [
          {
            workspaceId: 'main',
            projectId: 'p',
            canonicalGitRemote: 'github.com/u/r',
            repoRelativeWorkspacePath: '',
            localFallbackKey: null
          }
        ]
      }
    })
    const r = runPreflight({ snapshotDir: snapshot, db, pathsMapping: emptyMapping(), yes: false })
    expect(r.ok).toBe(true)
    expect(r.missingMappings).toHaveLength(1)
    expect(r.warnings.some((w) => /missing local path mapping for 1/.test(w))).toBe(true)
  })

  it('errors (blocks) when --yes is true (CI mode, no prompt)', () => {
    writeSnapshot({
      projectIds: ['p'],
      manifest: {
        workspaceIdentities: [
          {
            workspaceId: 'main',
            projectId: 'p',
            canonicalGitRemote: 'github.com/u/r',
            repoRelativeWorkspacePath: '',
            localFallbackKey: null
          }
        ]
      }
    })
    const r = runPreflight({ snapshotDir: snapshot, db, pathsMapping: emptyMapping(), yes: true })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => /missing local path mapping/.test(e))).toBe(true)
  })

  it('skips local-fallback workspaces (no mapping needed)', () => {
    writeSnapshot({
      projectIds: ['p'],
      manifest: {
        workspaceIdentities: [
          {
            workspaceId: 'sandbox',
            projectId: 'p',
            canonicalGitRemote: null,
            repoRelativeWorkspacePath: null,
            localFallbackKey: 'local:p:sandbox'
          }
        ]
      }
    })
    const r = runPreflight({ snapshotDir: snapshot, db, pathsMapping: emptyMapping(), yes: true })
    expect(r.missingMappings).toEqual([])
    expect(r.ok).toBe(true)
  })
})

describe('runPreflight — delete diff (AC #9)', () => {
  it('lists per-row IDs of rows present locally but missing from incoming snapshot', () => {
    seedTask('TASK-001', 'p')
    seedTask('TASK-002', 'p')
    seedTask('TASK-003', 'p')
    writeSnapshot({
      projectIds: ['p'],
      tasks: [
        { id: 'TASK-001', project_id: 'p', title: 't1', status: 'TODO' }
      ]
    })
    const r = runPreflight({ snapshotDir: snapshot, db, pathsMapping: emptyMapping(), yes: false })
    expect(r.ok).toBe(true)
    const taskPlan = r.deletePlan.find((p) => p.table === 'tasks')!
    expect(taskPlan.totalCount).toBe(2)
    expect(taskPlan.sampleIds.sort()).toEqual(['TASK-002', 'TASK-003'])
  })

  it('returns no delete plan when local rows are a subset of incoming', () => {
    seedTask('TASK-001', 'p')
    writeSnapshot({
      projectIds: ['p'],
      tasks: [
        { id: 'TASK-001', project_id: 'p', title: 't1', status: 'TODO' },
        { id: 'TASK-002', project_id: 'p', title: 't2', status: 'TODO' }
      ]
    })
    const r = runPreflight({ snapshotDir: snapshot, db, pathsMapping: emptyMapping(), yes: false })
    expect(r.deletePlan).toEqual([])
  })

  it('caps sampleIds at MAX_IDS_PER_TABLE and reports overflow', () => {
    for (let i = 1; i <= MAX_IDS_PER_TABLE + 5; i++) {
      seedTask(`TASK-${String(i).padStart(3, '0')}`, 'p')
    }
    writeSnapshot({ projectIds: ['p'], tasks: [] })
    const r = runPreflight({ snapshotDir: snapshot, db, pathsMapping: emptyMapping(), yes: false })
    const taskPlan = r.deletePlan.find((p) => p.table === 'tasks')!
    expect(taskPlan.totalCount).toBe(MAX_IDS_PER_TABLE + 5)
    expect(taskPlan.sampleIds).toHaveLength(MAX_IDS_PER_TABLE)

    const summary = formatPreflightSummary(r)
    expect(summary).toMatch(/\(5 more\)/)
  })

  it('ignores rows for projects NOT in manifest.projectIds (their data is left untouched)', () => {
    seedTask('TASK-001', 'p1')
    seedTask('TASK-100', 'p2')
    writeSnapshot({ projectIds: ['p1'], tasks: [] })
    const r = runPreflight({ snapshotDir: snapshot, db, pathsMapping: emptyMapping(), yes: false })
    const taskPlan = r.deletePlan.find((p) => p.table === 'tasks')!
    expect(taskPlan.sampleIds).toEqual(['TASK-001']) // p2's tasks NOT in delete plan
    expect(taskPlan.sampleIds).not.toContain('TASK-100')
  })
})

describe('runPreflight — knowledge missing files (AC #10a)', () => {
  it('reports knowledge entries whose file_path is not present locally', () => {
    const fakeRepo = path.join(tmp, 'fake-repo')
    fs.mkdirSync(fakeRepo, { recursive: true })
    // Only one of the two knowledge files exists locally.
    fs.writeFileSync(path.join(fakeRepo, 'present.md'), '# present', 'utf8')

    const mapping: PathsMapping = {
      version: PATHS_MAPPING_VERSION,
      mappings: { 'github.com/u/r:': fakeRepo }
    }

    writeSnapshot({
      projectIds: ['p'],
      manifest: {
        workspaceIdentities: [
          {
            workspaceId: 'main',
            projectId: 'p',
            canonicalGitRemote: 'github.com/u/r',
            repoRelativeWorkspacePath: '',
            localFallbackKey: null
          }
        ]
      },
      knowledge: [
        {
          slug: 'present-entry',
          project_id: 'p',
          workspace_id: 'main',
          file_path: 'present.md',
          title: 't',
          type: 'spike',
          scope: 'project',
          created_at: '2026-05-08T00:00:00.000Z',
          last_verified_at: '2026-05-08T00:00:00.000Z'
        },
        {
          slug: 'missing-entry',
          project_id: 'p',
          workspace_id: 'main',
          file_path: 'missing.md',
          title: 't',
          type: 'spike',
          scope: 'project',
          created_at: '2026-05-08T00:00:00.000Z',
          last_verified_at: '2026-05-08T00:00:00.000Z'
        }
      ]
    })

    const r = runPreflight({ snapshotDir: snapshot, db, pathsMapping: mapping, yes: false })
    expect(r.knowledgeMissing).toHaveLength(1)
    expect(r.knowledgeMissing[0].slug).toBe('missing-entry')
    expect(r.warnings.some((w) => /1 knowledge entries reference files not present/.test(w))).toBe(
      true
    )
  })
})

describe('formatPreflightSummary', () => {
  it('produces a stable human-readable summary including delete diff', () => {
    seedTask('TASK-100', 'p')
    seedTask('TASK-200', 'p')
    writeSnapshot({ projectIds: ['p'], tasks: [] })
    const r = runPreflight({ snapshotDir: snapshot, db, pathsMapping: emptyMapping(), yes: false })
    const summary = formatPreflightSummary(r)
    expect(summary).toMatch(/Delete diff/)
    expect(summary).toMatch(/tasks: 2/)
    expect(summary).toMatch(/TASK-100/)
    expect(summary).toMatch(/TASK-200/)
  })

  it('says "no rows will be removed" when delete plan is empty', () => {
    writeSnapshot({ projectIds: [] })
    const r = runPreflight({ snapshotDir: snapshot, db, pathsMapping: emptyMapping(), yes: false })
    expect(formatPreflightSummary(r)).toMatch(/no rows will be removed/)
  })
})
