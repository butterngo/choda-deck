import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import Database from 'better-sqlite3'
import { initSchema } from './repositories/schema'
import { ProjectRepository } from './repositories/project-repository'
import { KnowledgeRepository } from './repositories/knowledge-repository'
import {
  KnowledgeService,
  KnowledgeConflictError,
  KnowledgeNotFoundError,
  KnowledgeValidationError
} from './knowledge-service'
import type { GitOps } from './knowledge-git'
import { parseFrontmatter } from './knowledge-frontmatter'

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
