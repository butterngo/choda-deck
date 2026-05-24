// Sibling of embedding-store.test.ts — exercises the pgvector-backed store
// against a real Postgres + pgvector via testcontainers. Skipped when
// Linux Docker is unavailable (Windows CI).

import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import {
  describeIfDocker,
  startPostgresTestEnv,
  stopPostgresTestEnv,
  type PgTestEnv
} from '../../../../test/postgres-harness'
import { migrate } from '../../repositories/postgres/migrations'
import { PgVectorEmbeddingStore } from '../pgvector-embedding-store'
import type { EmbeddingProvider } from '../embedding-provider.interface'

const fakeProvider = (id: string, dims: number): EmbeddingProvider => ({
  id,
  dims,
  embed: async () => new Float32Array(dims),
  embedBatch: async (texts) => texts.map(() => new Float32Array(dims))
})

describeIfDocker('PgVectorEmbeddingStore', () => {
  let env: PgTestEnv
  let store: PgVectorEmbeddingStore

  const insertProject = async (): Promise<void> => {
    await env.conn.query(
      `INSERT INTO projects (id, name, cwd) VALUES ('p1', 'p1', '/tmp')
       ON CONFLICT (id) DO NOTHING`
    )
  }

  const insertKnowledgeRow = async (slug: string): Promise<void> => {
    await env.conn.query(
      `INSERT INTO knowledge_index
         (slug, project_id, scope, type, title, file_path, created_at, last_verified_at)
       VALUES ($1, 'p1', 'project', 'decision', $1, $2, '2026-01-01', '2026-01-01')`,
      [slug, `/tmp/${slug}.md`]
    )
  }

  beforeAll(async () => {
    env = await startPostgresTestEnv()
    await migrate(env.conn)
  }, 120_000)

  afterAll(async () => {
    if (env) await stopPostgresTestEnv(env)
  }, 30_000)

  beforeEach(async () => {
    await env.conn.query('DELETE FROM knowledge_embeddings')
    await env.conn.query('DELETE FROM knowledge_index')
    await env.conn.query('DELETE FROM projects')
    await insertProject()
    store = new PgVectorEmbeddingStore(env.conn)
  })

  it('ensureSchema flips isEnabled on first call when table is present', async () => {
    const report = await store.ensureSchema(fakeProvider('local-minilm-l6-v2', 384))
    expect(report.hadVecTable).toBe(true)
    expect(report.previousProviderId).toBeNull()
    expect(report.reembeddedAll).toBe(false)
    expect(store.isEnabled()).toBe(true)
  })

  it('ensureSchema is idempotent when active provider matches stored', async () => {
    const provider = fakeProvider('local-minilm-l6-v2', 384)
    await store.ensureSchema(provider)
    await insertKnowledgeRow('adr-001')
    await store.upsert('adr-001', provider.id, provider.dims, new Float32Array(384).fill(0.1))

    const second = new PgVectorEmbeddingStore(env.conn)
    const secondReport = await second.ensureSchema(provider)
    expect(secondReport.previousProviderId).toBe('local-minilm-l6-v2')
    expect(secondReport.reembeddedAll).toBe(false)

    const remaining = await env.conn.query<{ embedding_provider_id: string | null }>(
      'SELECT embedding_provider_id FROM knowledge_index WHERE slug = $1',
      ['adr-001']
    )
    expect(remaining.rows[0].embedding_provider_id).toBe('local-minilm-l6-v2')
  })

  it('ensureSchema clears rows + resets columns on provider mismatch', async () => {
    const oldProvider = fakeProvider('local-minilm-l6-v2', 384)
    await store.ensureSchema(oldProvider)
    await insertKnowledgeRow('adr-001')
    await store.upsert('adr-001', oldProvider.id, oldProvider.dims, new Float32Array(384).fill(0.5))

    const newProvider = fakeProvider('voyage-3-lite', 512)
    const fresh = new PgVectorEmbeddingStore(env.conn)
    const report = await fresh.ensureSchema(newProvider)

    expect(report.previousProviderId).toBe('local-minilm-l6-v2')
    expect(report.activeProviderId).toBe('voyage-3-lite')
    expect(report.reembeddedAll).toBe(true)

    const cleared = await env.conn.query<{
      embedding_provider_id: string | null
      embedding_dims: number | null
    }>(
      'SELECT embedding_provider_id, embedding_dims FROM knowledge_index WHERE slug = $1',
      ['adr-001']
    )
    expect(cleared.rows[0].embedding_provider_id).toBeNull()
    expect(cleared.rows[0].embedding_dims).toBeNull()

    const remainingVecs = await env.conn.query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM knowledge_embeddings'
    )
    expect(Number(remainingVecs.rows[0].n)).toBe(0)
  })

  it('search returns hits ordered by distance', async () => {
    const provider = fakeProvider('local-minilm-l6-v2', 4)
    await store.ensureSchema(provider)
    await insertKnowledgeRow('a')
    await insertKnowledgeRow('b')
    await insertKnowledgeRow('c')
    await store.upsert('a', provider.id, 4, new Float32Array([1, 0, 0, 0]))
    await store.upsert('b', provider.id, 4, new Float32Array([0, 1, 0, 0]))
    await store.upsert('c', provider.id, 4, new Float32Array([1, 0, 0, 0]))

    const hits = await store.search(new Float32Array([1, 0, 0, 0]), 3)
    expect(hits).toHaveLength(3)
    expect(hits[0].slug).toMatch(/^[ac]$/)
    expect(hits[0].distance).toBeLessThanOrEqual(hits[2].distance)
    expect(hits[hits.length - 1].slug).toBe('b')
  })

  it('upsert replaces an existing vector for the same slug', async () => {
    const provider = fakeProvider('local-minilm-l6-v2', 4)
    await store.ensureSchema(provider)
    await insertKnowledgeRow('a')
    await store.upsert('a', provider.id, 4, new Float32Array([1, 0, 0, 0]))
    await store.upsert('a', provider.id, 4, new Float32Array([0, 0, 0, 1]))

    const hits = await store.search(new Float32Array([0, 0, 0, 1]), 1)
    expect(hits[0].slug).toBe('a')
    expect(hits[0].distance).toBeLessThan(0.1)

    const rowCount = await env.conn.query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM knowledge_embeddings WHERE slug = $1',
      ['a']
    )
    expect(Number(rowCount.rows[0].n)).toBe(1)
  })

  it('delete removes vec row without touching knowledge_index', async () => {
    const provider = fakeProvider('local-minilm-l6-v2', 4)
    await store.ensureSchema(provider)
    await insertKnowledgeRow('a')
    await store.upsert('a', provider.id, 4, new Float32Array([1, 0, 0, 0]))

    await store.delete('a')
    const hits = await store.search(new Float32Array([1, 0, 0, 0]), 5)
    expect(hits).toHaveLength(0)

    const indexRow = await env.conn.query<{ slug: string }>(
      'SELECT slug FROM knowledge_index WHERE slug = $1',
      ['a']
    )
    expect(indexRow.rows[0]?.slug).toBe('a')
  })

  it('pendingSlugs returns rows missing or with mismatched provider, oldest first', async () => {
    const provider = fakeProvider('local-minilm-l6-v2', 4)
    await store.ensureSchema(provider)
    await env.conn.query(
      `INSERT INTO knowledge_index
         (slug, project_id, scope, type, title, file_path, created_at, last_verified_at)
       VALUES ('one', 'p1', 'project', 'decision', 'one', '/tmp/one.md',
               '2026-01-01T00:00:00.000Z', '2026-01-01')`
    )
    await env.conn.query(
      `INSERT INTO knowledge_index
         (slug, project_id, scope, type, title, file_path, created_at, last_verified_at,
          embedding_provider_id, embedding_dims)
       VALUES ('two', 'p1', 'project', 'decision', 'two', '/tmp/two.md',
               '2026-01-02T00:00:00.000Z', '2026-01-02', 'voyage-3-lite', 512)`
    )
    await env.conn.query(
      `INSERT INTO knowledge_index
         (slug, project_id, scope, type, title, file_path, created_at, last_verified_at)
       VALUES ('three', 'p1', 'project', 'decision', 'three', '/tmp/three.md',
               '2026-01-03T00:00:00.000Z', '2026-01-03')`
    )

    const pending = await store.pendingSlugs(provider.id)
    expect(pending).toEqual(['one', 'two', 'three'])
  })

  it('disables itself when the embeddings table is missing', async () => {
    // Simulate pre-migration state by dropping the table.
    await env.conn.query('DROP TABLE knowledge_embeddings')

    const fresh = new PgVectorEmbeddingStore(env.conn)
    const report = await fresh.ensureSchema(fakeProvider('local-minilm-l6-v2', 384))
    expect(fresh.isEnabled()).toBe(false)
    expect(report.hadVecTable).toBe(false)
    expect(await fresh.search(new Float32Array(384), 5)).toEqual([])

    // Restore for the rest of the suite — re-run the same migration body.
    await env.conn.query(
      `CREATE TABLE IF NOT EXISTS knowledge_embeddings (
         slug TEXT PRIMARY KEY REFERENCES knowledge_index(slug) ON DELETE CASCADE,
         provider_id TEXT NOT NULL,
         dims INTEGER NOT NULL,
         embedding vector NOT NULL
       )`
    )
  })
})

