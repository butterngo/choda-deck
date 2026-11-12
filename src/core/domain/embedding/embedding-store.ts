import type Database from 'better-sqlite3'
import type { EmbeddingProvider } from './embedding-provider.interface'
import type { KnowledgeSearchFilter } from '../knowledge-types'

export interface EmbeddingSearchHit {
  slug: string
  rowid: number
  distance: number
  providerId: string
}

export interface BackfillCandidate {
  rowid: number
  slug: string
  filePath: string
  providerId: string | null
  textHash: string | null
}

export interface EmbeddingMismatchReport {
  hadVecTable: boolean
  previousProviderId: string | null
  activeProviderId: string
  reembeddedAll: boolean
}

/**
 * Encapsulates the `knowledge_vec` virtual table (sqlite-vec). One per service.
 * When the extension is unavailable or the active provider is noop, the store
 * is "disabled" — all mutating ops no-op, search throws.
 */
export class EmbeddingStore {
  private readonly db: Database.Database
  private readonly extensionLoaded: boolean
  private vecTableReady = false

  constructor(db: Database.Database, extensionLoaded: boolean) {
    this.db = db
    this.extensionLoaded = extensionLoaded
  }

  isEnabled(): boolean {
    return this.extensionLoaded && this.vecTableReady
  }

  /**
   * Create `knowledge_vec` at the active provider's dim. If a previous provider
   * embedded any rows with a different id, drop the vec table, recreate it at
   * the new dim, and clear per-row metadata so a backfill pass can re-embed.
   */
  ensureSchema(provider: EmbeddingProvider): EmbeddingMismatchReport {
    const report: EmbeddingMismatchReport = {
      hadVecTable: false,
      previousProviderId: null,
      activeProviderId: provider.id,
      reembeddedAll: false
    }
    if (!this.extensionLoaded || provider.dims === 0) {
      return report
    }

    report.hadVecTable = this.vecTableExists()
    report.previousProviderId = this.detectPreviousProviderId()

    const mismatch = report.previousProviderId !== null && report.previousProviderId !== provider.id
    if (mismatch) {
      this.db.exec('DROP TABLE IF EXISTS knowledge_vec')
      this.db.exec(
        'UPDATE knowledge_index SET embedding_provider_id = NULL, embedding_dims = NULL, embedding_text_hash = NULL'
      )
      report.reembeddedAll = true
    }

    if (mismatch || !report.hadVecTable) {
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_vec USING vec0(embedding float[${provider.dims}])`
      )
    }

    this.vecTableReady = true
    return report
  }

  rowidForSlug(slug: string): number | null {
    const row = this.db.prepare('SELECT rowid FROM knowledge_index WHERE slug = ?').get(slug) as
      | { rowid: number }
      | undefined
    return row?.rowid ?? null
  }

  upsert(
    rowid: number,
    providerId: string,
    dims: number,
    vector: Float32Array,
    textHash: string | null = null
  ): void {
    if (!this.isEnabled()) return
    const json = JSON.stringify(Array.from(vector))
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM knowledge_vec WHERE rowid = ?').run(BigInt(rowid))
      this.db
        .prepare('INSERT INTO knowledge_vec(rowid, embedding) VALUES (?, ?)')
        .run(BigInt(rowid), json)
      this.db
        .prepare(
          'UPDATE knowledge_index SET embedding_provider_id = ?, embedding_dims = ?, embedding_text_hash = ? WHERE rowid = ?'
        )
        .run(providerId, dims, textHash, rowid)
    })
    tx()
  }

  delete(rowid: number): void {
    if (!this.extensionLoaded) return
    try {
      this.db.prepare('DELETE FROM knowledge_vec WHERE rowid = ?').run(BigInt(rowid))
    } catch {
      /* table may not exist yet */
    }
  }

  /* Slug-keyed wrappers — `EmbeddingStorePort` (slice 20b) is slug-first because
   * pgvector has no implicit rowid. Internally we still go through rowid since
   * sqlite-vec's virtual table keys on it. Public callers (`KnowledgeService`)
   * use these; the rowid methods stay for the existing `embedding-store.test.ts`
   * unit suite + any future backfill caller that already knows the rowid. */
  upsertBySlug(
    slug: string,
    providerId: string,
    dims: number,
    vector: Float32Array,
    textHash: string | null = null
  ): void {
    if (!this.isEnabled()) return
    const rowid = this.rowidForSlug(slug)
    if (rowid === null) return
    this.upsert(rowid, providerId, dims, vector, textHash)
  }

  deleteBySlug(slug: string): void {
    if (!this.extensionLoaded) return
    const rowid = this.rowidForSlug(slug)
    if (rowid === null) return
    this.delete(rowid)
  }

  /**
   * k nearest entries. With a filter, the KNN index cannot narrow before its
   * own k-cut (sqlite-vec takes `k` inside MATCH), so the filtered path scans
   * the matching rows with `vec_distance_l2` — the vec0 default metric, so the
   * distances equal the unfiltered path's — and cuts after (TASK-3259).
   */
  search(query: Float32Array, k: number, filter: KnowledgeSearchFilter = {}): EmbeddingSearchHit[] {
    if (!this.isEnabled()) return []
    const json = JSON.stringify(Array.from(query))
    const where: string[] = []
    const params: string[] = []
    if (filter.projectId !== undefined) {
      where.push('ki.project_id = ?')
      params.push(filter.projectId)
    }
    if (filter.type !== undefined) {
      where.push('ki.type = ?')
      params.push(filter.type)
    }
    if (filter.scope !== undefined) {
      where.push('ki.scope = ?')
      params.push(filter.scope)
    }
    const sql =
      where.length === 0
        ? `SELECT ki.slug, v.rowid AS rowid, v.distance AS distance,
                ki.embedding_provider_id AS provider_id
         FROM knowledge_vec v
         JOIN knowledge_index ki ON ki.rowid = v.rowid
         WHERE v.embedding MATCH ? AND k = ?
         ORDER BY v.distance`
        : `SELECT ki.slug, v.rowid AS rowid, vec_distance_l2(v.embedding, ?) AS distance,
                ki.embedding_provider_id AS provider_id
         FROM knowledge_vec v
         JOIN knowledge_index ki ON ki.rowid = v.rowid
         WHERE ${where.join(' AND ')}
         ORDER BY distance
         LIMIT ?`
    const args = where.length === 0 ? [json, k] : [json, ...params, k]
    const rows = this.db.prepare(sql).all(...args) as Array<{
      slug: string
      rowid: number | bigint
      distance: number
      provider_id: string | null
    }>
    return rows.map((r) => ({
      slug: r.slug,
      rowid: typeof r.rowid === 'bigint' ? Number(r.rowid) : r.rowid,
      distance: r.distance,
      providerId: r.provider_id ?? ''
    }))
  }

  /** Every knowledge row with what the backfill needs to decide (TASK-3261). */
  backfillCandidates(): BackfillCandidate[] {
    const rows = this.db
      .prepare(
        `SELECT rowid, slug, file_path, embedding_provider_id, embedding_text_hash
         FROM knowledge_index ORDER BY created_at ASC, rowid ASC`
      )
      .all() as Array<{
      rowid: number
      slug: string
      file_path: string
      embedding_provider_id: string | null
      embedding_text_hash: string | null
    }>
    return rows.map((r) => ({
      rowid: r.rowid,
      slug: r.slug,
      filePath: r.file_path,
      providerId: r.embedding_provider_id,
      textHash: r.embedding_text_hash
    }))
  }

  /**
   * Slugs whose row has no embedding yet (or whose provider doesn't match the
   * active one). Used by the backfill script and the in-process embed queue.
   */
  pendingSlugs(activeProviderId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT slug FROM knowledge_index
         WHERE embedding_provider_id IS NULL OR embedding_provider_id <> ?
         ORDER BY created_at ASC, rowid ASC`
      )
      .all(activeProviderId) as Array<{ slug: string }>
    return rows.map((r) => r.slug)
  }

  private vecTableExists(): boolean {
    const row = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_vec'")
      .get() as { name?: string } | undefined
    return !!row?.name
  }

  private detectPreviousProviderId(): string | null {
    const row = this.db
      .prepare(
        `SELECT embedding_provider_id AS pid FROM knowledge_index
         WHERE embedding_provider_id IS NOT NULL
         LIMIT 1`
      )
      .get() as { pid?: string } | undefined
    return row?.pid ?? null
  }
}
