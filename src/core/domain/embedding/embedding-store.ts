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
  title: string
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
 * Since TASK-3260 a knowledge entry has one vector per chunk of its text:
 * `knowledge_chunk_map` maps each vec rowid to its entry, and an entry
 * scores by its nearest chunk.
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

    // A knowledge_vec from before TASK-3260 is keyed by entry rowid, not chunk
    // id; reading it through the chunk map would pair vectors with the wrong
    // entries, so it is cleared like a provider change.
    const preChunkLayout = report.hadVecTable && !this.chunkTableExists()
    const mismatch =
      preChunkLayout ||
      (report.previousProviderId !== null && report.previousProviderId !== provider.id)
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS knowledge_chunk_map (
         chunk_id INTEGER PRIMARY KEY AUTOINCREMENT,
         entry_rowid INTEGER NOT NULL,
         chunk_index INTEGER NOT NULL
       )`
    )
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_knowledge_chunk_map_entry ON knowledge_chunk_map(entry_rowid)'
    )
    if (mismatch) {
      this.db.exec('DROP TABLE IF EXISTS knowledge_vec')
      this.db.exec('DELETE FROM knowledge_chunk_map')
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

  /** One-vector entry: the whole text is a single chunk. */
  upsert(
    rowid: number,
    providerId: string,
    dims: number,
    vector: Float32Array,
    textHash: string | null = null
  ): void {
    this.upsertChunks(rowid, providerId, dims, [vector], textHash)
  }

  /** Replaces every chunk vector of the entry at `rowid` (TASK-3260). */
  upsertChunks(
    rowid: number,
    providerId: string,
    dims: number,
    vectors: Float32Array[],
    textHash: string | null = null
  ): void {
    if (!this.isEnabled()) return
    const insertChunk = this.db.prepare(
      'INSERT INTO knowledge_chunk_map (entry_rowid, chunk_index) VALUES (?, ?)'
    )
    const insertVec = this.db.prepare('INSERT INTO knowledge_vec(rowid, embedding) VALUES (?, ?)')
    const tx = this.db.transaction(() => {
      this.deleteChunks(rowid)
      vectors.forEach((vector, i) => {
        const chunkId = insertChunk.run(rowid, i).lastInsertRowid
        insertVec.run(BigInt(chunkId), JSON.stringify(Array.from(vector)))
      })
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
      this.deleteChunks(rowid)
    } catch {
      /* tables may not exist yet */
    }
  }

  private deleteChunks(rowid: number): void {
    const ids = this.db
      .prepare('SELECT chunk_id FROM knowledge_chunk_map WHERE entry_rowid = ?')
      .all(rowid) as Array<{ chunk_id: number }>
    const del = this.db.prepare('DELETE FROM knowledge_vec WHERE rowid = ?')
    for (const { chunk_id } of ids) del.run(BigInt(chunk_id))
    this.db.prepare('DELETE FROM knowledge_chunk_map WHERE entry_rowid = ?').run(rowid)
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
    vectors: Float32Array[],
    textHash: string | null = null
  ): void {
    if (!this.isEnabled()) return
    const rowid = this.rowidForSlug(slug)
    if (rowid === null) return
    this.upsertChunks(rowid, providerId, dims, vectors, textHash)
  }

  deleteBySlug(slug: string): void {
    if (!this.extensionLoaded) return
    const rowid = this.rowidForSlug(slug)
    if (rowid === null) return
    this.delete(rowid)
  }

  /**
   * k nearest entries, each scored by its nearest chunk (TASK-3260). vec0 KNN
   * is an exhaustive scan too, so an exact `vec_distance_l2` scan grouped per
   * entry costs the same and needs no over-fetch: it returns k distinct
   * entries whenever k exist, filtered (TASK-3259) or not. L2 is vec0's
   * default metric, so the distances match what KNN reported before.
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
    const sql = `SELECT ki.slug, ki.rowid AS rowid, MIN(vec_distance_l2(v.embedding, ?)) AS distance,
              ki.embedding_provider_id AS provider_id
       FROM knowledge_vec v
       JOIN knowledge_chunk_map c ON c.chunk_id = v.rowid
       JOIN knowledge_index ki ON ki.rowid = c.entry_rowid
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       GROUP BY ki.rowid
       ORDER BY distance, ki.rowid
       LIMIT ?`
    const args = [json, ...params, k]
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

  /**
   * Nearest-chunk distance of each named entry to the query (TASK-3253), so a
   * hit found only by the lexical leg still carries a real `distance`.
   */
  distancesFor(query: Float32Array, slugs: string[]): Map<string, number> {
    const out = new Map<string, number>()
    if (!this.isEnabled() || slugs.length === 0) return out
    const rows = this.db
      .prepare(
        `SELECT ki.slug AS slug, MIN(vec_distance_l2(v.embedding, ?)) AS distance
         FROM knowledge_vec v
         JOIN knowledge_chunk_map c ON c.chunk_id = v.rowid
         JOIN knowledge_index ki ON ki.rowid = c.entry_rowid
         WHERE ki.slug IN (${slugs.map(() => '?').join(', ')})
         GROUP BY ki.rowid`
      )
      .all(JSON.stringify(Array.from(query)), ...slugs) as Array<{
      slug: string
      distance: number
    }>
    for (const r of rows) out.set(r.slug, r.distance)
    return out
  }

  /** Every knowledge row with what the backfill needs to decide (TASK-3261). */
  backfillCandidates(): BackfillCandidate[] {
    const rows = this.db
      .prepare(
        `SELECT rowid, slug, title, file_path, embedding_provider_id, embedding_text_hash
         FROM knowledge_index ORDER BY created_at ASC, rowid ASC`
      )
      .all() as Array<{
      rowid: number
      slug: string
      title: string
      file_path: string
      embedding_provider_id: string | null
      embedding_text_hash: string | null
    }>
    return rows.map((r) => ({
      rowid: r.rowid,
      slug: r.slug,
      title: r.title,
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

  private chunkTableExists(): boolean {
    const row = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_chunk_map'")
      .get() as { name?: string } | undefined
    return !!row?.name
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
