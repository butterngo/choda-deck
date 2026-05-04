import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { initSchema } from '../../repositories/schema'
import { EmbeddingStore } from '../embedding-store'
import type { EmbeddingProvider } from '../embedding-provider.interface'

const fakeProvider = (id: string, dims: number): EmbeddingProvider => ({
  id,
  dims,
  embed: async () => new Float32Array(dims),
  embedBatch: async (texts) => texts.map(() => new Float32Array(dims))
})

let tmpDir: string
let dbPath: string
let db: Database.Database
let store: EmbeddingStore

const insertProject = (): void => {
  db.prepare('INSERT OR IGNORE INTO projects (id, name, cwd) VALUES (?, ?, ?)').run(
    'p1',
    'p1',
    '/tmp'
  )
}

const insertKnowledgeRow = (slug: string): number => {
  db.prepare(
    `INSERT INTO knowledge_index
       (slug, project_id, scope, type, title, file_path, created_at, last_verified_at)
     VALUES (?, 'p1', 'project', 'decision', ?, ?, '2026-01-01', '2026-01-01')`
  ).run(slug, slug, `/tmp/${slug}.md`)
  const row = db.prepare('SELECT rowid FROM knowledge_index WHERE slug = ?').get(slug) as {
    rowid: number
  }
  return row.rowid
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'embedding-store-'))
  dbPath = path.join(tmpDir, 'test.db')
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  sqliteVec.load(db)
  initSchema(db)
  insertProject()
  store = new EmbeddingStore(db, true)
})

afterEach(() => {
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('EmbeddingStore', () => {
  it('ensureSchema creates knowledge_vec at provider dims on first call', () => {
    const report = store.ensureSchema(fakeProvider('local-minilm-l6-v2', 384))
    expect(report.hadVecTable).toBe(false)
    expect(report.previousProviderId).toBeNull()
    expect(report.reembeddedAll).toBe(false)
    expect(store.isEnabled()).toBe(true)

    const tbl = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_vec'")
      .get()
    expect(tbl).toBeTruthy()
  })

  it('ensureSchema is idempotent when active provider matches stored', () => {
    const provider = fakeProvider('local-minilm-l6-v2', 384)
    store.ensureSchema(provider)
    const rowid = insertKnowledgeRow('adr-001')
    store.upsert(rowid, provider.id, provider.dims, new Float32Array(384).fill(0.1))

    const second = new EmbeddingStore(db, true).ensureSchema(provider)
    expect(second.previousProviderId).toBe('local-minilm-l6-v2')
    expect(second.reembeddedAll).toBe(false)

    const remaining = db
      .prepare('SELECT embedding_provider_id FROM knowledge_index WHERE slug = ?')
      .get('adr-001') as { embedding_provider_id: string | null }
    expect(remaining.embedding_provider_id).toBe('local-minilm-l6-v2')
  })

  it('ensureSchema drops + recreates vec table on provider mismatch and clears columns', () => {
    const oldProvider = fakeProvider('local-minilm-l6-v2', 384)
    store.ensureSchema(oldProvider)
    const rowid = insertKnowledgeRow('adr-001')
    store.upsert(rowid, oldProvider.id, oldProvider.dims, new Float32Array(384).fill(0.5))

    const newProvider = fakeProvider('voyage-3-lite', 512)
    const report = new EmbeddingStore(db, true).ensureSchema(newProvider)

    expect(report.previousProviderId).toBe('local-minilm-l6-v2')
    expect(report.activeProviderId).toBe('voyage-3-lite')
    expect(report.reembeddedAll).toBe(true)

    const cleared = db
      .prepare('SELECT embedding_provider_id, embedding_dims FROM knowledge_index WHERE slug = ?')
      .get('adr-001') as { embedding_provider_id: string | null; embedding_dims: number | null }
    expect(cleared.embedding_provider_id).toBeNull()
    expect(cleared.embedding_dims).toBeNull()
  })

  it('search returns hits ordered by distance', () => {
    const provider = fakeProvider('local-minilm-l6-v2', 4)
    store.ensureSchema(provider)
    const a = insertKnowledgeRow('a')
    const b = insertKnowledgeRow('b')
    const c = insertKnowledgeRow('c')
    store.upsert(a, provider.id, 4, new Float32Array([1, 0, 0, 0]))
    store.upsert(b, provider.id, 4, new Float32Array([0, 1, 0, 0]))
    store.upsert(c, provider.id, 4, new Float32Array([1, 0, 0, 0]))

    const hits = store.search(new Float32Array([1, 0, 0, 0]), 3)
    expect(hits).toHaveLength(3)
    expect(hits[0].slug).toMatch(/^[ac]$/)
    expect(hits[0].distance).toBeLessThanOrEqual(hits[2].distance)
    expect(hits[hits.length - 1].slug).toBe('b')
  })

  it('upsert replaces an existing vector for the same rowid', () => {
    const provider = fakeProvider('local-minilm-l6-v2', 4)
    store.ensureSchema(provider)
    const rowid = insertKnowledgeRow('a')
    store.upsert(rowid, provider.id, 4, new Float32Array([1, 0, 0, 0]))
    store.upsert(rowid, provider.id, 4, new Float32Array([0, 0, 0, 1]))

    const hits = store.search(new Float32Array([0, 0, 0, 1]), 1)
    expect(hits[0].slug).toBe('a')
    expect(hits[0].distance).toBeLessThan(0.1)
  })

  it('delete removes vec row without touching knowledge_index', () => {
    const provider = fakeProvider('local-minilm-l6-v2', 4)
    store.ensureSchema(provider)
    const rowid = insertKnowledgeRow('a')
    store.upsert(rowid, provider.id, 4, new Float32Array([1, 0, 0, 0]))

    store.delete(rowid)
    const hits = store.search(new Float32Array([1, 0, 0, 0]), 5)
    expect(hits).toHaveLength(0)

    const indexRow = db.prepare('SELECT slug FROM knowledge_index WHERE rowid = ?').get(rowid)
    expect(indexRow).toBeTruthy()
  })

  it('pendingSlugs returns rows missing or with mismatched provider, oldest first', () => {
    const provider = fakeProvider('local-minilm-l6-v2', 4)
    store.ensureSchema(provider)
    insertKnowledgeRow('one')
    insertKnowledgeRow('two')
    db.prepare(
      `UPDATE knowledge_index SET embedding_provider_id = ?, embedding_dims = ? WHERE slug = ?`
    ).run('voyage-3-lite', 512, 'two')
    insertKnowledgeRow('three')

    const pending = store.pendingSlugs(provider.id)
    expect(pending).toEqual(['one', 'two', 'three'])
  })

  it('disables itself when extension is not loaded', () => {
    const inertStore = new EmbeddingStore(db, false)
    const report = inertStore.ensureSchema(fakeProvider('local-minilm-l6-v2', 384))
    expect(inertStore.isEnabled()).toBe(false)
    expect(report.hadVecTable).toBe(false)
    expect(inertStore.search(new Float32Array(384), 5)).toEqual([])
  })
})
