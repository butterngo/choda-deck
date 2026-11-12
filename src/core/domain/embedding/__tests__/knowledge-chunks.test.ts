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
import { CHUNK_OVERLAP, CHUNK_WORDS, embeddingChunks } from '../embedding-backfill'
import type { EmbeddingProvider } from '../embedding-provider.interface'
import type { GitOps } from '../../knowledge-git'

const words = (prefix: string, n: number): string =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ')

describe('embeddingChunks (TASK-3260)', () => {
  it('keeps a short body as one chunk headed by the title', () => {
    expect(embeddingChunks('My Title', 'a short body')).toEqual(['My Title\n\na short body'])
  })

  it('cuts a long body into overlapping windows, each headed by the title', () => {
    const chunks = embeddingChunks('T', words('w', 500))
    const bodies = chunks.map((c) => c.replace(/^T\n\n/, '').split(' '))
    expect(chunks.every((c) => c.startsWith('T\n\n'))).toBe(true)
    expect(bodies.every((b) => b.length <= CHUNK_WORDS)).toBe(true)
    // consecutive windows share CHUNK_OVERLAP words
    expect(bodies[1].slice(0, CHUNK_OVERLAP)).toEqual(bodies[0].slice(-CHUNK_OVERLAP))
    // every word lands in some window, and the last window ends at the last word
    expect(new Set(bodies.flat()).size).toBe(500)
    expect(bodies[bodies.length - 1].at(-1)).toBe('w499')
  })

  it('a body of exactly CHUNK_WORDS words is one chunk', () => {
    expect(embeddingChunks('T', words('w', CHUNK_WORDS))).toHaveLength(1)
  })
})

// Bag-of-words provider that, like MiniLM, reads only the first WINDOW words
// of its input and drops the rest. Normalised, so length does not dominate.
const WINDOW = 230
class TruncatingProvider implements EmbeddingProvider {
  readonly id = 'truncating-test'
  readonly dims = 1024
  async embed(text: string): Promise<Float32Array> {
    const v = new Float32Array(this.dims)
    for (const w of text.split(/\s+/).slice(0, WINDOW)) {
      let h = 0
      for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) >>> 0
      v[h % this.dims] += 1
    }
    const norm = Math.hypot(...v) || 1
    return v.map((x) => x / norm)
  }
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)))
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
let store: EmbeddingStore
let svc: KnowledgeService
let provider: TruncatingProvider

const seed = async (slug: string, body: string): Promise<void> => {
  await svc.createKnowledge({
    projectId: 'p1',
    type: 'decision',
    scope: 'project',
    title: slug,
    body,
    refs: [],
    slug
  })
}
const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 80))
const l2 = (a: Float32Array, b: Float32Array): number =>
  Math.hypot(...Array.from(a, (x, i) => x - b[i]))
const count = (d: Database.Database, sql: string, ...args: unknown[]): number =>
  Number((d.prepare(sql).get(...args) as { n: number }).n)

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-chunks-'))
  db = new Database(path.join(tmpDir, 'test.db'))
  sqliteVec.load(db)
  initSchema(db)
  const projects = new ProjectRepository(db)
  fs.mkdirSync(path.join(tmpDir, 'repo'))
  projects.ensure('p1', 'p1', path.join(tmpDir, 'repo'))
  store = new EmbeddingStore(db, true)
  provider = new TruncatingProvider()
  store.ensureSchema(provider)
  svc = new KnowledgeService({
    knowledge: new KnowledgeRepository(db),
    projects,
    git,
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

const query = 'kafka partition rebalance storm'
const deepBody = `${words('filler', 300)} ${query}`
// Each decoy shares one query word, in a short body.
const decoys = ['kafka', 'partition', 'rebalance', 'storm', 'kafka partition'].map(
  (w, i) => [`decoy-${i}`, `${w} ${words(`noise${i}x`, 20)}`] as const
)

const chunksOf = (slug: string): number =>
  count(
    db,
    `SELECT COUNT(*) n FROM knowledge_chunk_map c
     JOIN knowledge_index ki ON ki.rowid = c.entry_rowid WHERE ki.slug = ?`,
    slug
  )

describe('chunked knowledge vectors (TASK-3260)', () => {
  it('finds an entry whose only match sits after its first 300 words', async () => {
    await seed('deep', deepBody)
    for (const [slug, body] of decoys) await seed(slug, body)
    await drain()

    const hits = await svc.searchKnowledge(query, 5)
    expect(hits.results.map((r) => r.slug)).toContain('deep')

    // The same entry as ONE vector (the pre-TASK-3260 store) is farther from
    // the query than all five decoys, so a single-vector store would leave it
    // out of the top 5.
    const q = await provider.embed(query)
    const single = l2(q, await provider.embed(`deep\n\n${deepBody}`))
    for (const [slug, body] of decoys) {
      expect(l2(q, await provider.embed(`${slug}\n\n${body}`))).toBeLessThan(single)
    }
  })

  it('never returns the same slug twice when several of its chunks are nearest', async () => {
    await seed('many', Array.from({ length: 6 }, () => `${query} ${words('pad', 190)}`).join(' '))
    await seed('other', 'unrelated text entirely')
    await drain()
    expect(chunksOf('many')).toBeGreaterThan(3)

    const hits = await svc.searchKnowledge(query, 5)
    expect(hits.results.map((r) => r.slug)).toEqual(['many', 'other'])
  })

  it('an update replaces every chunk, and a delete leaves none', async () => {
    await seed('entry', words('old', 500))
    await drain()
    expect(chunksOf('entry')).toBe(3)

    await svc.updateKnowledge({ slug: 'entry', body: 'now short' })
    await drain()
    expect(chunksOf('entry')).toBe(1)
    expect(count(db, 'SELECT COUNT(*) n FROM knowledge_vec')).toBe(1)

    await svc.deleteKnowledge('entry')
    await drain()
    expect(count(db, 'SELECT COUNT(*) n FROM knowledge_chunk_map')).toBe(0)
    expect(count(db, 'SELECT COUNT(*) n FROM knowledge_vec')).toBe(0)
  })

  it('clears a pre-chunk vector table instead of reading it through the chunk map', () => {
    const old = new Database(path.join(tmpDir, 'old.db'))
    sqliteVec.load(old)
    initSchema(old)
    old.exec('CREATE VIRTUAL TABLE knowledge_vec USING vec0(embedding float[1024])')
    old.prepare("INSERT INTO projects (id, name, cwd) VALUES ('p1', 'p1', ?)").run(tmpDir)
    old
      .prepare(
        `INSERT INTO knowledge_index
           (slug, project_id, scope, type, title, file_path, created_at, last_verified_at,
            embedding_provider_id, embedding_dims)
         VALUES ('legacy', 'p1', 'project', 'decision', 'legacy', '/x.md', '2026-01-01',
                 '2026-01-01', 'truncating-test', 1024)`
      )
      .run()
    old
      .prepare('INSERT INTO knowledge_vec(rowid, embedding) VALUES (1, ?)')
      .run(JSON.stringify(Array(1024).fill(0.1)))

    const report = new EmbeddingStore(old, true).ensureSchema(provider)

    expect(report.reembeddedAll).toBe(true)
    expect(count(old, 'SELECT COUNT(*) n FROM knowledge_vec')).toBe(0)
    const row = old
      .prepare("SELECT embedding_provider_id p FROM knowledge_index WHERE slug = 'legacy'")
      .get() as { p: string | null }
    expect(row.p).toBeNull()
    old.close()
  })
})
