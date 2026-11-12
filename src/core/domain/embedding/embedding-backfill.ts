import { createHash } from 'crypto'
import type { EmbeddingProvider } from './embedding-provider.interface'
import type { EmbeddingStore } from './embedding-store'
import { parseFrontmatter } from '../knowledge-frontmatter'
import type { KnowledgeLexicalIndex } from './lexical-index'

// TASK-3261 / TASK-3260 — one definition of "the texts a knowledge entry is
// embedded from", shared by the service's embed-on-write and the backfill, so
// the stored hash means the same thing on both paths.
//
// MiniLM reads about 256 tokens (~190 words) and drops the rest; 81% of
// entries are longer. So the body is cut into windows of CHUNK_WORDS words,
// each overlapping the previous by CHUNK_OVERLAP so a phrase on a boundary is
// whole in one of them, and every window carries the title.
export const CHUNK_WORDS = 200
export const CHUNK_OVERLAP = 40

export function embeddingChunks(title: string, body: string): string[] {
  const head = title.trim()
  const words = body
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
  const withTitle = (ws: string[]): string => `${head}\n\n${ws.join(' ')}`.trim()
  if (words.length <= CHUNK_WORDS) return [withTitle(words)]
  const chunks: string[] = []
  for (let start = 0; ; start += CHUNK_WORDS - CHUNK_OVERLAP) {
    const end = Math.min(start + CHUNK_WORDS, words.length)
    chunks.push(withTitle(words.slice(start, end)))
    if (end === words.length) return chunks
  }
}

export function embeddingTextHash(chunks: string[]): string {
  return createHash('sha256').update(JSON.stringify(chunks)).digest('hex')
}

/**
 * The note's title and body. The title is the frontmatter's when it parses
 * (disk wins over the index, TASK-1432), else the index row's.
 */
export function noteText(raw: string, indexTitle: string): { title: string; body: string } {
  try {
    const { frontmatter, body } = parseFrontmatter(raw)
    return { title: frontmatter.title || indexTitle, body }
  } catch {
    return { title: indexTitle, body: raw }
  }
}

export interface BackfillReport {
  embedded: string[]
  unchanged: number
  /** Rows whose file is gone. Reported, never embedded or deleted (TASK-3261). */
  orphans: Array<{ slug: string; filePath: string }>
  failed: Array<{ slug: string; reason: string }>
}

/**
 * Embeds every knowledge row whose stored vectors are missing, from another
 * provider, or from text that no longer matches its file. A file edited on
 * disk outside updateKnowledge is picked up here; before TASK-3261 it kept
 * its old vector for good.
 */
export async function runEmbeddingBackfill(
  store: EmbeddingStore,
  provider: EmbeddingProvider,
  readFile: (filePath: string) => string | null,
  onProgress: (slug: string) => void = () => {},
  lexical: KnowledgeLexicalIndex | null = null
): Promise<BackfillReport> {
  const report: BackfillReport = { embedded: [], unchanged: 0, orphans: [], failed: [] }
  for (const row of store.backfillCandidates()) {
    const raw = readFile(row.filePath)
    if (raw === null) {
      report.orphans.push({ slug: row.slug, filePath: row.filePath })
      continue
    }
    const { title, body } = noteText(raw, row.title)
    // TASK-3253 — cheap and idempotent, so every entry with a file is
    // rewritten; this is also how rows written before the FTS table get in.
    lexical?.upsert(row.slug, title, body)
    const chunks = embeddingChunks(title, body)
    if (chunks.every((c) => c.length === 0)) {
      report.failed.push({ slug: row.slug, reason: 'empty title and body' })
      continue
    }
    const hash = embeddingTextHash(chunks)
    if (row.providerId === provider.id && row.textHash === hash) {
      report.unchanged++
      continue
    }
    try {
      const vectors = await provider.embedBatch(chunks)
      store.upsertChunks(row.rowid, provider.id, provider.dims, vectors, hash)
      report.embedded.push(row.slug)
      onProgress(row.slug)
    } catch (err) {
      report.failed.push({ slug: row.slug, reason: (err as Error).message })
    }
  }
  return report
}
