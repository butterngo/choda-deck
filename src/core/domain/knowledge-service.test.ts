import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import Database from 'better-sqlite3'
import { initSchema } from './repositories/schema'
import { ProjectRepository } from './repositories/project-repository'
import { WorkspaceRepository } from './repositories/workspace-repository'
import { KnowledgeRepository } from './repositories/knowledge-repository'
import {
  KnowledgeService,
  KnowledgeConflictError,
  KnowledgeNotFoundError,
  KnowledgeValidationError
} from './knowledge-service'
import type { GitOps } from './knowledge-git'
import { parseFrontmatter, serializeFrontmatter } from './knowledge-frontmatter'

class FakeGitOps implements GitOps {
  headSha = 'head1'
  commitsSinceMap = new Map<string, number>()

  getHeadSha(): string {
    return this.headSha
  }

  countCommitsSince(_cwd: string, sinceSha: string, filePath: string): number {
    const key = `${sinceSha}::${filePath}`
    return this.commitsSinceMap.get(key) ?? 0
  }

  isAncestor(): boolean {
    return true
  }

  filesInCommit(): string[] {
    return []
  }
}

let tmpDir: string
let projectCwd: string
let dbPath: string
let db: Database.Database
let projects: ProjectRepository
let repo: KnowledgeRepository
let git: FakeGitOps
let svc: KnowledgeService

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-test-'))
  projectCwd = path.join(tmpDir, 'repo')
  fs.mkdirSync(projectCwd, { recursive: true })
  dbPath = path.join(tmpDir, 'test.db')
  db = new Database(dbPath)
  initSchema(db)
  projects = new ProjectRepository(db)
  projects.ensure('proj-k', 'Knowledge Test', projectCwd)
  repo = new KnowledgeRepository(db)
  git = new FakeGitOps()
  svc = new KnowledgeService({
    db,
    knowledge: repo,
    projects,
    git,
    contentRoot: path.join(tmpDir, 'vault'),
    now: () => new Date('2026-04-29T00:00:00Z')
  })
})

afterEach(() => {
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('createKnowledge', () => {
  it('writes file + index + INDEX.md for project scope', () => {
    git.headSha = 'sha-aaa'
    const entry = svc.createKnowledge({
      projectId: 'proj-k',
      type: 'decision',
      scope: 'project',
      title: 'Test Decision',
      body: '# body content\n\nsome text\n',
      refs: [{ path: 'src/foo.ts' }]
    })

    expect(entry.slug).toBe('test-decision')
    expect(entry.frontmatter.refs[0].commitSha).toBe('sha-aaa')
    expect(fs.existsSync(entry.filePath)).toBe(true)

    const raw = fs.readFileSync(entry.filePath, 'utf8')
    const { frontmatter, body } = parseFrontmatter(raw)
    expect(frontmatter.type).toBe('decision')
    expect(frontmatter.refs).toEqual([{ path: 'src/foo.ts', commitSha: 'sha-aaa' }])
    expect(body).toContain('# body content')

    const indexRow = repo.get('test-decision')
    expect(indexRow?.title).toBe('Test Decision')

    const indexMd = fs.readFileSync(path.join(projectCwd, 'docs', 'knowledge', 'INDEX.md'), 'utf8')
    expect(indexMd).toContain('test-decision')
    expect(indexMd).toContain('Test Decision')
  })

  it('rejects duplicate slug', () => {
    svc.createKnowledge({
      projectId: 'proj-k',
      type: 'decision',
      scope: 'project',
      title: 'Same Title',
      body: 'a',
      refs: []
    })
    expect(() =>
      svc.createKnowledge({
        projectId: 'proj-k',
        type: 'decision',
        scope: 'project',
        title: 'Same Title',
        body: 'b',
        refs: []
      })
    ).toThrow(KnowledgeConflictError)
  })

  it('rejects unknown projectId', () => {
    expect(() =>
      svc.createKnowledge({
        projectId: 'no-such',
        type: 'decision',
        scope: 'project',
        title: 'X',
        body: 'b',
        refs: []
      })
    ).toThrow(KnowledgeValidationError)
  })
})

describe('getKnowledge — staleness', () => {
  it('returns isStale=true with per-ref commitsSince', () => {
    git.headSha = 'sha-aaa'
    svc.createKnowledge({
      projectId: 'proj-k',
      type: 'spike',
      scope: 'project',
      title: 'Spike One',
      body: 'spike body',
      refs: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }]
    })

    git.commitsSinceMap.set('sha-aaa::src/a.ts', 3)
    git.commitsSinceMap.set('sha-aaa::src/b.ts', 0)

    const entry = svc.getKnowledge('spike-one')
    expect(entry).not.toBeNull()
    expect(entry?.staleness).toEqual([
      { path: 'src/a.ts', commitSha: 'sha-aaa', commitsSince: 3 },
      { path: 'src/b.ts', commitSha: 'sha-aaa', commitsSince: 0 }
    ])
    expect(entry?.isStale).toBe(true)
  })

  it('returns null for missing slug', () => {
    expect(svc.getKnowledge('nope')).toBeNull()
  })
})

describe('listKnowledge', () => {
  it('filters by type', () => {
    svc.createKnowledge({
      projectId: 'proj-k',
      type: 'decision',
      scope: 'project',
      title: 'D1',
      body: 'a',
      refs: []
    })
    svc.createKnowledge({
      projectId: 'proj-k',
      type: 'spike',
      scope: 'project',
      title: 'S1',
      body: 'a',
      refs: []
    })

    const decisions = svc.listKnowledge({ type: 'decision' })
    expect(decisions).toHaveLength(1)
    expect(decisions[0].slug).toBe('d1')

    const all = svc.listKnowledge()
    expect(all).toHaveLength(2)
  })
})

describe('deleteKnowledge', () => {
  it('removes file + DB row + regenerates INDEX.md', () => {
    svc.createKnowledge({
      projectId: 'proj-k',
      type: 'spike',
      scope: 'project',
      title: 'Disposable',
      body: 'b',
      refs: []
    })
    const filePath = path.join(projectCwd, 'docs', 'knowledge', 'disposable.md')
    const indexMdPath = path.join(projectCwd, 'docs', 'knowledge', 'INDEX.md')
    expect(fs.existsSync(filePath)).toBe(true)

    const result = svc.deleteKnowledge('disposable')
    expect(result.slug).toBe('disposable')
    expect(result.deletedFile).toBe(true)
    expect(fs.existsSync(filePath)).toBe(false)
    expect(repo.get('disposable')).toBeNull()

    const indexMd = fs.readFileSync(indexMdPath, 'utf8')
    expect(indexMd).toContain('No entries yet')
  })

  it('throws KnowledgeNotFoundError on missing slug', () => {
    expect(() => svc.deleteKnowledge('nope')).toThrow(KnowledgeNotFoundError)
  })
})

describe('updateKnowledge', () => {
  it('updates body, re-pins refs to HEAD, bumps lastVerifiedAt', () => {
    git.headSha = 'sha-old'
    svc.createKnowledge({
      projectId: 'proj-k',
      type: 'decision',
      scope: 'project',
      title: 'Edit Me',
      body: 'old body\n',
      refs: [{ path: 'src/y.ts' }]
    })
    git.commitsSinceMap.set('sha-old::src/y.ts', 4)
    expect(svc.getKnowledge('edit-me')?.isStale).toBe(true)

    git.headSha = 'sha-new'
    git.commitsSinceMap.set('sha-new::src/y.ts', 0)
    const result = svc.updateKnowledge({ slug: 'edit-me', body: 'new body\n' })

    expect(result.body).toBe('new body\n')
    expect(result.frontmatter.refs[0].commitSha).toBe('sha-new')
    expect(result.frontmatter.lastVerifiedAt).toBe('2026-04-29')
    expect(result.isStale).toBe(false)

    const after = svc.getKnowledge('edit-me')
    expect(after?.body).toContain('new body')
    expect(after?.body).not.toContain('old body')
    expect(after?.frontmatter.refs[0].commitSha).toBe('sha-new')
    expect(after?.isStale).toBe(false)
  })

  it('replaces refs when provided, body unchanged', () => {
    git.headSha = 'sha-aaa'
    svc.createKnowledge({
      projectId: 'proj-k',
      type: 'spike',
      scope: 'project',
      title: 'Refs Only',
      body: 'keep me\n',
      refs: [{ path: 'src/old.ts' }]
    })

    git.headSha = 'sha-bbb'
    const result = svc.updateKnowledge({
      slug: 'refs-only',
      refs: [{ path: 'src/new1.ts' }, { path: 'src/new2.ts' }]
    })

    expect(result.body).toContain('keep me')
    expect(result.frontmatter.refs).toEqual([
      { path: 'src/new1.ts', commitSha: 'sha-bbb' },
      { path: 'src/new2.ts', commitSha: 'sha-bbb' }
    ])
  })

  it('throws KnowledgeNotFoundError on missing slug', () => {
    expect(() => svc.updateKnowledge({ slug: 'nope', body: 'x' })).toThrow(KnowledgeNotFoundError)
  })

  it('throws KnowledgeValidationError when neither body nor refs provided', () => {
    svc.createKnowledge({
      projectId: 'proj-k',
      type: 'spike',
      scope: 'project',
      title: 'No Op',
      body: 'b',
      refs: []
    })
    expect(() => svc.updateKnowledge({ slug: 'no-op' })).toThrow(KnowledgeValidationError)
  })

  it('regenerates INDEX.md after update', () => {
    svc.createKnowledge({
      projectId: 'proj-k',
      type: 'decision',
      scope: 'project',
      title: 'Reindex',
      body: 'old',
      refs: []
    })
    const indexMdPath = path.join(projectCwd, 'docs', 'knowledge', 'INDEX.md')
    fs.unlinkSync(indexMdPath)
    expect(fs.existsSync(indexMdPath)).toBe(false)

    svc.updateKnowledge({ slug: 'reindex', body: 'new body\n' })

    const after = fs.readFileSync(indexMdPath, 'utf8')
    expect(after).toContain('reindex')
  })
})

describe('verifyKnowledge', () => {
  it('re-pins refs to new HEAD and resets staleness', () => {
    git.headSha = 'sha-old'
    svc.createKnowledge({
      projectId: 'proj-k',
      type: 'learning',
      scope: 'project',
      title: 'Learn One',
      body: 'b',
      refs: [{ path: 'src/x.ts' }]
    })
    git.commitsSinceMap.set('sha-old::src/x.ts', 5)

    const before = svc.getKnowledge('learn-one')
    expect(before?.isStale).toBe(true)

    git.headSha = 'sha-new'
    git.commitsSinceMap.set('sha-new::src/x.ts', 0)
    const result = svc.verifyKnowledge('learn-one')

    expect(result.isStale).toBe(false)
    expect(result.refs[0].commitSha).toBe('sha-new')

    const after = svc.getKnowledge('learn-one')
    expect(after?.frontmatter.refs[0].commitSha).toBe('sha-new')
    expect(after?.isStale).toBe(false)
  })
})

// ── ADR-022 (TASK-651) — workspace-scoped knowledge ──────────────────────────
describe('workspace-scoped knowledge', () => {
  let workspaces: WorkspaceRepository
  let workspaceCwd: string
  let wsSvc: KnowledgeService

  beforeEach(() => {
    workspaces = new WorkspaceRepository(db)
    workspaceCwd = path.join(tmpDir, 'ws-repo')
    fs.mkdirSync(workspaceCwd, { recursive: true })
    workspaces.add('proj-k', 'ws-1', 'Workspace 1', workspaceCwd)
    // sibling project + workspace to test cross-project guard
    projects.ensure('proj-other', 'Other', path.join(tmpDir, 'other'))
    workspaces.add('proj-other', 'ws-other', 'Other WS', path.join(tmpDir, 'other-ws'))
    wsSvc = new KnowledgeService({
      db,
      knowledge: repo,
      projects,
      workspaces,
      git,
      contentRoot: path.join(tmpDir, 'vault'),
      now: () => new Date('2026-04-29T00:00:00Z')
    })
  })

  it('createKnowledge with workspaceId writes file under workspaceCwd', () => {
    const entry = wsSvc.createKnowledge({
      projectId: 'proj-k',
      workspaceId: 'ws-1',
      type: 'decision',
      scope: 'project',
      title: 'WS Decision',
      body: 'body\n',
      refs: []
    })

    expect(entry.filePath).toBe(path.join(workspaceCwd, 'docs', 'knowledge', 'ws-decision.md'))
    expect(fs.existsSync(entry.filePath)).toBe(true)
    expect(entry.frontmatter.workspaceId).toBe('ws-1')

    const indexRow = repo.get('ws-decision')
    expect(indexRow?.workspaceId).toBe('ws-1')

    const wsIndex = fs.readFileSync(path.join(workspaceCwd, 'docs', 'knowledge', 'INDEX.md'), 'utf8')
    expect(wsIndex).toContain('ws-decision')
    expect(wsIndex).toContain('proj-k/ws-1')

    // Project INDEX.md should not list it
    const projIndexPath = path.join(projectCwd, 'docs', 'knowledge', 'INDEX.md')
    if (fs.existsSync(projIndexPath)) {
      const projIndex = fs.readFileSync(projIndexPath, 'utf8')
      expect(projIndex).not.toContain('ws-decision')
    }
  })

  it('createKnowledge rejects workspaceId from a different project', () => {
    expect(() =>
      wsSvc.createKnowledge({
        projectId: 'proj-k',
        workspaceId: 'ws-other',
        type: 'decision',
        scope: 'project',
        title: 'Cross Project',
        body: 'b',
        refs: []
      })
    ).toThrow(KnowledgeValidationError)
  })

  it('createKnowledge rejects unknown workspaceId', () => {
    expect(() =>
      wsSvc.createKnowledge({
        projectId: 'proj-k',
        workspaceId: 'no-such-ws',
        type: 'decision',
        scope: 'project',
        title: 'Bad',
        body: 'b',
        refs: []
      })
    ).toThrow(KnowledgeValidationError)
  })

  it('listKnowledge filters by workspaceId', () => {
    wsSvc.createKnowledge({
      projectId: 'proj-k',
      workspaceId: 'ws-1',
      type: 'decision',
      scope: 'project',
      title: 'WS Entry',
      body: 'b',
      refs: []
    })
    wsSvc.createKnowledge({
      projectId: 'proj-k',
      type: 'decision',
      scope: 'project',
      title: 'Project Entry',
      body: 'b',
      refs: []
    })

    expect(wsSvc.listKnowledge({ workspaceId: 'ws-1' })).toHaveLength(1)
    expect(wsSvc.listKnowledge({ workspaceId: 'ws-1' })[0].slug).toBe('ws-entry')
    expect(wsSvc.listKnowledge({ workspaceId: null })).toHaveLength(1)
    expect(wsSvc.listKnowledge({ workspaceId: null })[0].slug).toBe('project-entry')
    expect(wsSvc.listKnowledge({ projectId: 'proj-k' })).toHaveLength(2)
  })

  it('frontmatter round-trip preserves workspaceId', () => {
    wsSvc.createKnowledge({
      projectId: 'proj-k',
      workspaceId: 'ws-1',
      type: 'decision',
      scope: 'project',
      title: 'Round Trip',
      body: 'b',
      refs: []
    })
    const filePath = path.join(workspaceCwd, 'docs', 'knowledge', 'round-trip.md')
    const raw = fs.readFileSync(filePath, 'utf8')
    expect(raw).toContain('workspaceId: ws-1')
    const { frontmatter } = parseFrontmatter(raw)
    expect(frontmatter.workspaceId).toBe('ws-1')
  })

  describe('registerExistingKnowledge', () => {
    function writePreExisting(targetCwd: string, slug: string, workspaceId?: string): string {
      const fp = path.join(targetCwd, 'docs', 'knowledge', `${slug}.md`)
      fs.mkdirSync(path.dirname(fp), { recursive: true })
      const content = serializeFrontmatter(
        {
          type: 'decision',
          title: `Title ${slug}`,
          projectId: 'proj-k',
          workspaceId,
          scope: 'project',
          refs: [],
          createdAt: '2026-01-15',
          lastVerifiedAt: '2026-01-15'
        },
        '# body\n'
      )
      fs.writeFileSync(fp, content, 'utf8')
      return fp
    }

    it('indexes an existing workspace-scoped file without rewriting it', () => {
      const fp = writePreExisting(workspaceCwd, 'pre-existing', 'ws-1')
      const before = fs.readFileSync(fp, 'utf8')

      const entry = wsSvc.registerExistingKnowledge({
        filePath: fp,
        projectId: 'proj-k',
        workspaceId: 'ws-1'
      })

      expect(entry.slug).toBe('pre-existing')
      expect(entry.frontmatter.createdAt).toBe('2026-01-15')

      const after = fs.readFileSync(fp, 'utf8')
      expect(after).toBe(before) // not modified

      const row = repo.get('pre-existing')
      expect(row?.workspaceId).toBe('ws-1')
      expect(row?.title).toBe('Title pre-existing')
    })

    it('is idempotent on re-run', () => {
      const fp = writePreExisting(workspaceCwd, 'idem', 'ws-1')
      wsSvc.registerExistingKnowledge({
        filePath: fp,
        projectId: 'proj-k',
        workspaceId: 'ws-1'
      })
      wsSvc.registerExistingKnowledge({
        filePath: fp,
        projectId: 'proj-k',
        workspaceId: 'ws-1'
      })
      expect(repo.list({ projectId: 'proj-k', workspaceId: 'ws-1' })).toHaveLength(1)
    })

    it('rejects projectId mismatch with frontmatter', () => {
      const fp = writePreExisting(workspaceCwd, 'mismatch', 'ws-1')
      expect(() =>
        wsSvc.registerExistingKnowledge({
          filePath: fp,
          projectId: 'proj-other',
          workspaceId: 'ws-1'
        })
      ).toThrow(KnowledgeValidationError)
    })

    it('rejects workspaceId mismatch with frontmatter', () => {
      const fp = writePreExisting(workspaceCwd, 'wsmismatch', 'ws-1')
      expect(() =>
        wsSvc.registerExistingKnowledge({
          filePath: fp,
          projectId: 'proj-k',
          workspaceId: undefined
        })
      ).toThrow(KnowledgeValidationError)
    })

    it('rejects file that does not exist', () => {
      expect(() =>
        wsSvc.registerExistingKnowledge({
          filePath: path.join(tmpDir, 'nope.md'),
          projectId: 'proj-k'
        })
      ).toThrow(KnowledgeValidationError)
    })
  })

  it('schema migration is idempotent (re-run initSchema is safe)', () => {
    expect(() => initSchema(db)).not.toThrow()
    expect(() => initSchema(db)).not.toThrow()
    // workspace_id column still queryable
    const cols = db.pragma('table_info(knowledge_index)') as Array<{ name: string }>
    expect(cols.some((c) => c.name === 'workspace_id')).toBe(true)
  })
})
