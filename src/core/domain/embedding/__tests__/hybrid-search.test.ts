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
import { KnowledgeLexicalIndex, RRF_K, ftsQuery, rrfFuse } from '../lexical-index'
import type { EmbeddingProvider } from '../embedding-provider.interface'
import type { GitOps } from '../../knowledge-git'

describe('rrfFuse (TASK-3253)', () => {
  it('sums 1/(RRF_K + rank) over the lists an entry appears in', () => {
    const fused = rrfFuse([
      ['a', 'b', 'c'],
      ['c', 'a']
    ])
    const score = Object.fromEntries(fused.map((f) => [f.slug, f.score]))
    expect(score.a).toBeCloseTo(1 / (RRF_K + 1) + 1 / (RRF_K + 2), 12)
    expect(score.b).toBeCloseTo(1 / (RRF_K + 2), 12)
    expect(score.c).toBeCloseTo(1 / (RRF_K + 3) + 1 / (RRF_K + 1), 12)
    expect(fused.map((f) => f.slug)).toEqual(['a', 'c', 'b'])
  })

  it('an entry in one list only can still outrank one ranked low in both', () => {
    const fused = rrfFuse([
      ['solo', ...Array.from({ length: 100 }, (_, i) => `x${i}`), 'both'],
      [...Array.from({ length: 100 }, (_, i) => `y${i}`), 'both']
    ])
    const order = fused.map((f) => f.slug)
    expect(order.indexOf('solo')).toBeLessThan(order.indexOf('both'))
  })
})

describe('ftsQuery', () => {
  it('quotes every word so FTS5 operators never reach the parser', () => {
    expect(ftsQuery('TASK-3252: "foo" -bar*')).toBe('"TASK" OR "3252" OR "foo" OR "bar"')
    expect(ftsQuery('QUEUE_AC_FINAL_VERIFY_NUDGE')).toBe('"QUEUE_AC_FINAL_VERIFY_NUDGE"')
    expect(ftsQuery('  -- ** ""  ')).toBeNull()
  })
})

// Vectors carry no lexical signal at all: every text gets the same vector, so
// any ranking difference in these tests comes from the lexical leg.
class FlatProvider implements EmbeddingProvider {
  readonly id = 'flat-test'
  readonly dims = 4
  async embed(): Promise<Float32Array> {
    return Float32Array.from([1, 0, 0, 0])
  }
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map(() => this.embed()))
  }
}

const git: GitOps = {
  getHeadSha: () => 'sha',
  countCommitsSince: () => 0,
  isAncestor: () => true,
  filesInCommit: () => []
}

let tmpDir: string
let db: Database.Database
let svc: KnowledgeService
let store: EmbeddingStore

const fts = (slug: string): { title: string; body: string } | undefined =>
  db.prepare('SELECT title, body FROM knowledge_fts WHERE slug = ?').get(slug) as
    | { title: string; body: string }
    | undefined

const seed = async (slug: string, body: string, projectId = 'p1'): Promise<void> => {
  await svc.createKnowledge({
    projectId,
    type: 'decision',
    scope: 'project',
    title: slug,
    body,
    refs: [],
    slug
  })
}
const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 60))

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybrid-search-'))
  db = new Database(path.join(tmpDir, 'test.db'))
  sqliteVec.load(db)
  initSchema(db)
  const projects = new ProjectRepository(db)
  for (const id of ['p1', 'p2']) {
    fs.mkdirSync(path.join(tmpDir, id))
    projects.ensure(id, id, path.join(tmpDir, id))
  }
  store = new EmbeddingStore(db, true)
  const provider = new FlatProvider()
  store.ensureSchema(provider)
  svc = new KnowledgeService({
    knowledge: new KnowledgeRepository(db),
    projects,
    git,
    contentRoot: path.join(tmpDir, 'vault'),
    now: () => new Date('2026-05-04T00:00:00Z'),
    embeddingStore: store,
    embeddingProvider: async () => provider,
    lexicalIndex: new KnowledgeLexicalIndex(db)
  })
})

afterEach(() => {
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('hybrid knowledge_search (TASK-3253)', () => {
  it('create writes the FTS row', async () => {
    await seed('made', 'body with checkpointSession inside')
    expect(fts('made')).toEqual({ title: 'made', body: 'body with checkpointSession inside' })
  })

  it('update rewrites the FTS row', async () => {
    await seed('changed', 'old words here')
    await svc.updateKnowledge({ slug: 'changed', body: 'new words now' })
    expect(fts('changed')?.body).toContain('new words now')
    expect(fts('changed')?.body).not.toContain('old words')
  })

  it('delete removes the FTS row', async () => {
    await seed('gone', 'temporary entry')
    await svc.deleteKnowledge('gone')
    expect(fts('gone')).toBeUndefined()
  })

  it('an exact identifier puts its entry first even when vectors cannot tell entries apart', async () => {
    for (let i = 0; i < 8; i++) await seed(`filler-${i}`, `ordinary prose number ${i}`)
    await seed('target', 'the guard lives in QUEUE_AC_FINAL_VERIFY_NUDGE and nowhere else')
    await drain()

    const hits = await svc.searchKnowledge('QUEUE_AC_FINAL_VERIFY_NUDGE', 5)
    expect(hits.results[0].slug).toBe('target')
    expect(typeof hits.results[0].distance).toBe('number')
    expect(hits.results[0].score).toBeGreaterThan(hits.results[1].score)
  })

  it('an exact-identifier entry with no vector is still returned, weak and without a distance', async () => {
    for (let i = 0; i < 4; i++) await seed(`filler-${i}`, `ordinary prose number ${i}`)
    await seed('unembedded', 'the knob is CONNECTOR_PRODUCT_ID and nothing else')
    await drain()
    store.deleteBySlug('unembedded')

    const hits = await svc.searchKnowledge('CONNECTOR_PRODUCT_ID', 5)
    const hit = hits.results.find((h) => h.slug === 'unembedded')
    expect(hit).toBeDefined()
    expect(hit!.distance).toBeNull()
    expect(hit!.weak).toBe(true)
    expect(hits.lexicalMatches).toBeGreaterThan(0)
  })

  it('a query full of FTS syntax characters returns results instead of an error', async () => {
    await seed('ticket', 'notes about TASK-3252 and foo')
    await drain()

    const hits = await svc.searchKnowledge('TASK-3252: "foo" -bar*', 5)
    expect(hits.enabled).toBe(true)
    expect(hits.results.map((r) => r.slug)).toContain('ticket')
  })

  it('with a projectId filter neither leg returns an entry of another project', async () => {
    await seed('mine', 'shared identifier zebraCase', 'p1')
    for (let i = 0; i < 3; i++) await seed(`theirs-${i}`, 'shared identifier zebraCase', 'p2')
    await drain()

    const lexicalOnly = new KnowledgeLexicalIndex(db).search('zebraCase', 10, { projectId: 'p1' })
    expect(lexicalOnly).toEqual(['mine'])
    const hits = await svc.searchKnowledge('zebraCase', 10, { projectId: 'p1' })
    expect(hits.results.map((r) => r.slug)).toEqual(['mine'])
  })
})
