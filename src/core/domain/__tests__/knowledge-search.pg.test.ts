// Smoke sibling of embedding/__tests__/knowledge-search.test.ts — drives
// searchKnowledge through PostgresTaskService.
//
// Two test paths:
//   1. PG facade with CHODA_EMBEDDING_PROVIDER=noop → search returns
//      enabled=false with a reason (proves the wiring no longer throws
//      PostgresNotImplementedError, the slice 20a stub).
//   2. KnowledgeService constructed directly with PgVectorEmbeddingStore +
//      a fake known-dim provider → embed → search round-trip against real
//      pgvector. Bypassing the facade lets the test pin a provider without
//      changing PostgresTaskService's production constructor signature.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  describeIfDocker,
  startPostgresTestEnv,
  stopPostgresTestEnv,
  type PgTestEnv
} from '../../../test/postgres-harness'
import { PostgresTaskService } from '../postgres-task-service'
import { KnowledgeService } from '../knowledge-service'
import { PostgresKnowledgeRepository } from '../repositories/postgres/knowledge-repository.pg'
import { PostgresProjectRepository } from '../repositories/postgres/project-repository.pg'
import { PostgresWorkspaceRepository } from '../repositories/postgres/workspace-repository.pg'
import { PgVectorEmbeddingStore } from '../embedding/pgvector-embedding-store'
import type { EmbeddingProvider } from '../embedding/embedding-provider.interface'
import { migrate } from '../repositories/postgres/migrations'

class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'fake-test-provider'
  readonly dims = 4
  // Map of body text → vector. Falls back to a zero vector for unknown text.
  private readonly fixed = new Map<string, number[]>()

  setVector(text: string, vec: number[]): void {
    this.fixed.set(text, vec)
  }

  async embed(text: string): Promise<Float32Array> {
    const v = this.fixed.get(text) ?? [0, 0, 0, 0]
    return new Float32Array(v)
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)))
  }
}

describeIfDocker('PostgresTaskService searchKnowledge (slice 20b)', () => {
  let env: PgTestEnv

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
    await env.conn.query('DELETE FROM workspaces')
    await env.conn.query('DELETE FROM projects')
  })

  describe('via PostgresTaskService facade — noop provider', () => {
    const prevEnv = process.env.CHODA_EMBEDDING_PROVIDER

    beforeAll(() => {
      process.env.CHODA_EMBEDDING_PROVIDER = 'noop'
    })

    afterAll(() => {
      if (prevEnv === undefined) delete process.env.CHODA_EMBEDDING_PROVIDER
      else process.env.CHODA_EMBEDDING_PROVIDER = prevEnv
    })

    it('returns enabled=false with reason when provider is noop', async () => {
      const svc = new PostgresTaskService(env.conn)
      await svc.initializeAsync()

      const r = await svc.searchKnowledge('anything')
      expect(r.enabled).toBe(false)
      expect(r.reason).toBeTruthy()
      expect(r.results).toEqual([])
      /* slice 20a guard: must NOT throw PostgresNotImplementedError */
    })
  })

  describe('via direct KnowledgeService wiring — fake provider round-trip', () => {
    let tmpDir: string
    let projectCwd: string
    let provider: FakeEmbeddingProvider
    let store: PgVectorEmbeddingStore
    let knowledge: PostgresKnowledgeRepository
    let projects: PostgresProjectRepository
    let workspaces: PostgresWorkspaceRepository
    let svc: KnowledgeService

    beforeEach(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-search-pg-'))
      projectCwd = path.join(tmpDir, 'repo')
      fs.mkdirSync(projectCwd, { recursive: true })

      provider = new FakeEmbeddingProvider()
      store = new PgVectorEmbeddingStore(env.conn)
      knowledge = new PostgresKnowledgeRepository(env.conn)
      projects = new PostgresProjectRepository(env.conn)
      workspaces = new PostgresWorkspaceRepository(env.conn)
      await projects.ensure('proj-s', 'Search Project', projectCwd)

      svc = new KnowledgeService({
        knowledge,
        projects,
        workspaces,
        embeddingStore: store,
        embeddingProvider: async () => provider
      })

      const report = await store.ensureSchema(provider)
      expect(report.hadVecTable).toBe(true)
    })

    /* scheduleEmbed is fire-and-forget — assert via polling so the test isn't
     * timing-sensitive on slow CI. Poll the row's embedding_provider_id; once
     * the embed lands, that column flips from NULL to the provider id. */
    const waitForEmbedded = async (slug: string, timeoutMs = 3000): Promise<void> => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const r = await env.conn.query<{ embedding_provider_id: string | null }>(
          'SELECT embedding_provider_id FROM knowledge_index WHERE slug = $1',
          [slug]
        )
        if (r.rows[0]?.embedding_provider_id) return
        await new Promise((res) => setTimeout(res, 50))
      }
      throw new Error(`embedding for ${slug} did not land within ${timeoutMs}ms`)
    }

    it('embeds on create + ranks by vector distance on search', async () => {
      provider.setVector('alpha body', [1, 0, 0, 0])
      provider.setVector('beta body', [0, 1, 0, 0])
      provider.setVector('alpha-ish body', [0.95, 0.05, 0, 0])
      provider.setVector('alpha-query', [1, 0, 0, 0])

      const created = await Promise.all([
        svc.createKnowledge({
          projectId: 'proj-s',
          scope: 'project',
          type: 'decision',
          title: 'Alpha',
          body: 'alpha body',
          refs: []
        }),
        svc.createKnowledge({
          projectId: 'proj-s',
          scope: 'project',
          type: 'decision',
          title: 'Beta',
          body: 'beta body',
          refs: []
        }),
        svc.createKnowledge({
          projectId: 'proj-s',
          scope: 'project',
          type: 'decision',
          title: 'Alpha-ish',
          body: 'alpha-ish body',
          refs: []
        })
      ])
      for (const c of created) await waitForEmbedded(c.slug)

      const result = await svc.searchKnowledge('alpha-query', 3)
      expect(result.enabled).toBe(true)
      expect(result.providerId).toBe('fake-test-provider')
      const slugs = result.results.map((r) => r.slug)
      // Closest to [1,0,0,0] is alpha (exact), then alpha-ish (0.95), then beta.
      expect(slugs[0]).toBe('alpha')
      expect(slugs[1]).toBe('alpha-ish')
      expect(slugs[2]).toBe('beta')
      expect(result.results[0].distance).toBeLessThan(result.results[1].distance)
    })

    it('deleteKnowledge removes the embedding row (FK-safe order)', async () => {
      provider.setVector('to delete', [0.5, 0.5, 0, 0])
      const c = await svc.createKnowledge({
        projectId: 'proj-s',
        scope: 'project',
        type: 'decision',
        title: 'To Delete',
        body: 'to delete',
        refs: []
      })
      await waitForEmbedded(c.slug)

      const before = await env.conn.query(
        'SELECT slug FROM knowledge_embeddings WHERE slug = $1',
        [c.slug]
      )
      expect(before.rows).toHaveLength(1)

      await svc.deleteKnowledge(c.slug)

      const after = await env.conn.query(
        'SELECT slug FROM knowledge_embeddings WHERE slug = $1',
        [c.slug]
      )
      expect(after.rows).toHaveLength(0)
    })
  })
})
