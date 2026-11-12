import type Database from 'better-sqlite3'
import type { KnowledgeSearchFilter } from '../knowledge-types'

// TASK-3253 — the lexical leg of knowledge_search: an FTS5 table over each
// entry's title and body, ranked by bm25(). Exact identifiers (error strings,
// TASK-NNN, function and tool names) are what the vector leg misses; on the
// TASK-3252 baseline the identifier class had MRR 0.259 against 0.625 for
// paraphrases.

// bm25() takes one weight per column, in table order: slug (unindexed), title,
// body. A title hit counts five body hits.
const BM25_WEIGHTS = '0.0, 5.0, 1.0'

/**
 * A free-text query as an FTS5 MATCH expression that cannot be a syntax error:
 * every word becomes a quoted string, joined with OR so an entry matching some
 * of the words still ranks. Characters FTS5 treats as operators (`-`, `:`,
 * `"`, `*`, parentheses) never reach the parser. Null when the query has no
 * word at all.
 */
export function ftsQuery(query: string): string | null {
  const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? []
  if (terms.length === 0) return null
  return [...new Set(terms)].map((t) => `"${t}"`).join(' OR ')
}

export class KnowledgeLexicalIndex {
  constructor(private readonly db: Database.Database) {}

  upsert(slug: string, title: string, body: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM knowledge_fts WHERE slug = ?').run(slug)
      this.db
        .prepare('INSERT INTO knowledge_fts (slug, title, body) VALUES (?, ?, ?)')
        .run(slug, title, body)
    })
    tx()
  }

  delete(slug: string): void {
    this.db.prepare('DELETE FROM knowledge_fts WHERE slug = ?').run(slug)
  }

  /** Slugs ranked best-first by bm25, filtered before the k-cut (TASK-3259). */
  search(query: string, k: number, filter: KnowledgeSearchFilter = {}): string[] {
    const match = ftsQuery(query)
    if (match === null) return []
    const where = ['knowledge_fts MATCH ?']
    const params: string[] = [match]
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
    const rows = this.db
      .prepare(
        `SELECT f.slug AS slug
         FROM knowledge_fts f
         JOIN knowledge_index ki ON ki.slug = f.slug
         WHERE ${where.join(' AND ')}
         ORDER BY bm25(knowledge_fts, ${BM25_WEIGHTS}), f.slug
         LIMIT ?`
      )
      .all(...params, k) as Array<{ slug: string }>
    return rows.map((r) => r.slug)
  }
}

// Reciprocal Rank Fusion (Cormack et al. 2009): an entry scores
// Σ 1/(RRF_K + rank) over the lists it appears in, rank counted from 1. Ranks
// only, so a bm25 score and an L2 distance never have to share a scale.
export const RRF_K = 60

export function rrfFuse(
  lists: string[][],
  weights: number[] = lists.map(() => 1)
): Array<{ slug: string; score: number }> {
  const score = new Map<string, number>()
  const firstSeen = new Map<string, number>()
  let order = 0
  for (const [li, list] of lists.entries()) {
    list.forEach((slug, i) => {
      score.set(slug, (score.get(slug) ?? 0) + weights[li] / (RRF_K + i + 1))
      if (!firstSeen.has(slug)) firstSeen.set(slug, order++)
    })
  }
  return [...score.entries()]
    .map(([slug, s]) => ({ slug, score: s }))
    .sort((a, b) => b.score - a.score || firstSeen.get(a.slug)! - firstSeen.get(b.slug)!)
}
