// ADR-030 — pgvector sibling of the sqlite-vec EmbeddingStore.
//
// Two key differences from the SQLite side:
//
// 1. Async API — every mutating + reading op returns a Promise. pgvector
//    runs over network/socket via pg.Pool, no sync option. Consumers
//    (KnowledgeService) need to be made async to use this; that refactor
//    is the next slice — this file lands the building block.
//
// 2. Slug-keyed, not rowid-keyed — Postgres has no implicit rowid. The
//    sqlite side juggles `rowidForSlug` because sqlite-vec's virtual table
//    keys on rowid; here we just FK directly on slug.
//
// Vector ↔ JS marshalling: serialize Float32Array to pgvector's text form
// `[v1,v2,...]` and cast via `$N::vector` on the way in. Reading back
// returns a string in the same format — only `distance` (a real number)
// is exposed on EmbeddingSearchHit, so we never need to parse vectors
// back. This avoids taking on the `pgvector` npm package as a runtime dep.

import type { PgConnection } from '../repositories/postgres/connection'
import type { EmbeddingProvider } from './embedding-provider.interface'

export interface EmbeddingSearchHit {
  slug: string
  distance: number
  providerId: string
}

export interface EmbeddingMismatchReport {
  hadVecTable: boolean
  previousProviderId: string | null
  activeProviderId: string
  reembeddedAll: boolean
}

function toVectorLiteral(vec: Float32Array): string {
  let out = '['
  for (let i = 0; i < vec.length; i++) {
    if (i > 0) out += ','
    out += vec[i].toString()
  }
  out += ']'
  return out
}

export class PgVectorEmbeddingStore {
  private readonly conn: PgConnection
  private vecTableReady = false

  constructor(conn: PgConnection) {
    this.conn = conn
  }

  isEnabled(): boolean {
    return this.vecTableReady
  }

  /**
   * Verify the pgvector schema is present and clear stale rows if the active
   * provider differs from the previously-stored one. The migration creates
   * the extension + table; this method only handles provider-mismatch
   * cleanup and flips `vecTableReady` so mutating ops start succeeding.
   */
  async ensureSchema(provider: EmbeddingProvider): Promise<EmbeddingMismatchReport> {
    const report: EmbeddingMismatchReport = {
      hadVecTable: false,
      previousProviderId: null,
      activeProviderId: provider.id,
      reembeddedAll: false
    }
    if (provider.dims === 0) {
      return report
    }

    report.hadVecTable = await this.vecTableExists()
    if (!report.hadVecTable) {
      // Migration hasn't run — store stays disabled.
      return report
    }

    report.previousProviderId = await this.detectPreviousProviderId()

    const mismatch =
      report.previousProviderId !== null && report.previousProviderId !== provider.id
    if (mismatch) {
      await this.conn.transaction(async (tx) => {
        await tx.query('DELETE FROM knowledge_embeddings')
        await tx.query(
          'UPDATE knowledge_index SET embedding_provider_id = NULL, embedding_dims = NULL'
        )
      })
      report.reembeddedAll = true
    }

    this.vecTableReady = true
    return report
  }

  async upsert(
    slug: string,
    providerId: string,
    dims: number,
    vector: Float32Array
  ): Promise<void> {
    if (!this.isEnabled()) return
    const literal = toVectorLiteral(vector)
    await this.conn.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO knowledge_embeddings (slug, provider_id, dims, embedding)
         VALUES ($1, $2, $3, $4::vector)
         ON CONFLICT (slug)
         DO UPDATE SET provider_id = EXCLUDED.provider_id,
                       dims = EXCLUDED.dims,
                       embedding = EXCLUDED.embedding`,
        [slug, providerId, dims, literal]
      )
      await tx.query(
        'UPDATE knowledge_index SET embedding_provider_id = $1, embedding_dims = $2 WHERE slug = $3',
        [providerId, dims, slug]
      )
    })
  }

  async delete(slug: string): Promise<void> {
    if (!this.vecTableReady) return
    await this.conn.query('DELETE FROM knowledge_embeddings WHERE slug = $1', [slug])
  }

  async search(query: Float32Array, k: number): Promise<EmbeddingSearchHit[]> {
    if (!this.isEnabled()) return []
    const literal = toVectorLiteral(query)
    const result = await this.conn.query<{
      slug: string
      distance: string | number
      provider_id: string | null
    }>(
      `SELECT ki.slug,
              (ke.embedding <-> $1::vector) AS distance,
              ki.embedding_provider_id AS provider_id
       FROM knowledge_embeddings ke
       JOIN knowledge_index ki ON ki.slug = ke.slug
       ORDER BY ke.embedding <-> $1::vector
       LIMIT $2`,
      [literal, k]
    )
    return result.rows.map((r) => ({
      slug: r.slug,
      distance: typeof r.distance === 'string' ? Number(r.distance) : r.distance,
      providerId: r.provider_id ?? ''
    }))
  }

  /**
   * Slugs whose knowledge_index row has no embedding yet or whose provider
   * doesn't match the active one. Used by backfill jobs.
   */
  async pendingSlugs(activeProviderId: string): Promise<string[]> {
    const result = await this.conn.query<{ slug: string }>(
      `SELECT slug FROM knowledge_index
       WHERE embedding_provider_id IS NULL OR embedding_provider_id <> $1
       ORDER BY created_at ASC, slug ASC`,
      [activeProviderId]
    )
    return result.rows.map((r) => r.slug)
  }

  private async vecTableExists(): Promise<boolean> {
    const result = await this.conn.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_name = 'knowledge_embeddings'
       ) AS exists`
    )
    return result.rows[0]?.exists === true
  }

  private async detectPreviousProviderId(): Promise<string | null> {
    const result = await this.conn.query<{ pid: string }>(
      `SELECT embedding_provider_id AS pid FROM knowledge_index
       WHERE embedding_provider_id IS NOT NULL
       LIMIT 1`
    )
    return result.rows[0]?.pid ?? null
  }
}
