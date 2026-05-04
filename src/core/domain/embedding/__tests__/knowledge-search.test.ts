import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { initSchema } from '../../repositories/schema'
import { ProjectRepository } from '../../repositories/project-repository'
import { KnowledgeRepository } from '../../repositories/knowledge-repository'
import { KnowledgeService } from '../../knowledge-service'
import { EmbeddingStore } from '../embedding-store'
import { NoopEmbeddingProvider } from '../noop-embedding-provider'
import type { EmbeddingProvider } from '../embedding-provider.interface'
import type { GitOps } from '../../knowledge-git'

class FakeGit implements GitOps {
  getHeadSha(): string {
    return 'sha'
  }
  countCommitsSince(): number {
    return 0
  }
  isAncestor(): boolean {
    return true
  }
  filesInCommit(): string[] {
    return []
  }
}

// Deterministic fake provider — embedding is the bag-of-chars vector for
// debugging plus a known signature dimension. Same input → same vector → same
// distance, so search ordering is predictable.
class FakeProvider implements EmbeddingProvider {
  readonly id = 'fake-test-provider'
  readonly dims = 8

  async embed(text: string): Promise<Float32Array> {
    const v = new Float32Array(this.dims)
    for (let i = 0; i < text.length; i++) v[i % this.dims] += text.charCodeAt(i) / 1000
    return v
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)))
  }
}

let tmpDir: string
let projectCwd: string
let db: Database.Database
let store: EmbeddingStore
let svc: KnowledgeService
let provider: FakeProvider

const seedKnowledge = (slug: string, body: string): void => {
  svc.createKnowledge({
    projectId: 'proj-s',
    type: 'decision',
    scope: 'project',
    title: slug,
    body,
    refs: [],
    slug
  })
}

const waitForEmbedQueue = async (): Promise<void> => {
  // KnowledgeService.scheduleEmbed fires Promise chains — drain microtasks.
  await new Promise((r) => setTimeout(r, 50))
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-search-'))
  projectCwd = path.join(tmpDir, 'repo')
  fs.mkdirSync(projectCwd, { recursive: true })
  db = new Database(path.join(tmpDir, 'test.db'))
  db.pragma('journal_mode = WAL')
  sqliteVec.load(db)
  initSchema(db)
  const projects = new ProjectRepository(db)
  projects.ensure('proj-s', 'Search Test', projectCwd)
  const repo = new KnowledgeRepository(db)
  store = new EmbeddingStore(db, true)
  provider = new FakeProvider()
  store.ensureSchema(provider)
  svc = new KnowledgeService({
    db,
    knowledge: repo,
    projects,
    git: new FakeGit(),
    contentRoot: path.join(tmpDir, 'vault'),
    now: () => new Date('2026-05-04T00:00:00Z'),
    embeddingStore: store,
    embeddingProvider: async () => provider
  })
})

afterEach(() => {
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('KnowledgeService.searchKnowledge', () => {
  it('returns enabled=false with reason when no provider is configured', async () => {
    const bareSvc = new KnowledgeService({
      db,
      knowledge: new KnowledgeRepository(db),
      projects: new ProjectRepository(db)
    })
    const result = await bareSvc.searchKnowledge('anything')
    expect(result.enabled).toBe(false)
    expect(result.reason).toMatch(/not configured/i)
    expect(result.results).toEqual([])
  })

  it('returns enabled=false when provider is noop', async () => {
    const noopSvc = new KnowledgeService({
      db,
      knowledge: new KnowledgeRepository(db),
      projects: new ProjectRepository(db),
      embeddingStore: store,
      embeddingProvider: async () => new NoopEmbeddingProvider('disabled')
    })
    const result = await noopSvc.searchKnowledge('anything')
    expect(result.enabled).toBe(false)
    expect(result.providerId).toBe('noop')
  })

  it('embeds new knowledge and returns it as the top hit for the same query', async () => {
    seedKnowledge('about-cats', 'cats are small soft mammals that purr')
    seedKnowledge('about-dogs', 'dogs bark and run very fast')
    seedKnowledge('about-fish', 'fish swim silently in water')
    await waitForEmbedQueue()

    const hits = await svc.searchKnowledge('cats are small soft mammals that purr', 3)
    expect(hits.enabled).toBe(true)
    expect(hits.providerId).toBe('fake-test-provider')
    expect(hits.results[0].slug).toBe('about-cats')
    expect(hits.results[0].distance).toBeLessThan(0.001)
  })

  it('updates the vector when knowledge body changes', async () => {
    seedKnowledge('alpha', 'first body original text')
    await waitForEmbedQueue()

    svc.updateKnowledge({ slug: 'alpha', body: 'completely different replacement content here' })
    await waitForEmbedQueue()

    const hits = await svc.searchKnowledge('completely different replacement content here', 1)
    expect(hits.results[0].slug).toBe('alpha')
    expect(hits.results[0].distance).toBeLessThan(0.001)
  })

  it('removes the vector when knowledge is deleted', async () => {
    seedKnowledge('temp', 'this is a transient entry')
    await waitForEmbedQueue()

    svc.deleteKnowledge('temp')
    await waitForEmbedQueue()

    const hits = await svc.searchKnowledge('this is a transient entry', 5)
    expect(hits.results.find((r) => r.slug === 'temp')).toBeUndefined()
  })
})
