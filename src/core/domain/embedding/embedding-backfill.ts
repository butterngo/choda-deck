import { createHash } from 'crypto'
import type { EmbeddingProvider } from './embedding-provider.interface'
import type { EmbeddingStore } from './embedding-store'

// TASK-3261 — one definition of "the text a knowledge entry is embedded from",
// shared by the service's embed-on-write and the backfill, so the stored hash
// means the same thing on both paths.
export function embeddingText(body: string): string {
  return body.trim()
}

export function embeddingTextHash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/

/** The note's body: the file minus its frontmatter block, if it has one. */
export function bodyOfNote(raw: string): string {
  const m = raw.match(FRONTMATTER_RE)
  return m ? m[1] : raw
}

export interface BackfillReport {
  embedded: string[]
  unchanged: number
  /** Rows whose file is gone. Reported, never embedded or deleted (TASK-3261). */
  orphans: Array<{ slug: string; filePath: string }>
  failed: Array<{ slug: string; reason: string }>
}

/**
 * Embeds every knowledge row whose stored vector is missing, from another
 * provider, or from text that no longer matches its file. A file edited on
 * disk outside updateKnowledge is picked up here; before TASK-3261 it kept
 * its old vector for good.
 */
export async function runEmbeddingBackfill(
  store: EmbeddingStore,
  provider: EmbeddingProvider,
  readFile: (filePath: string) => string | null,
  onProgress: (slug: string) => void = () => {}
): Promise<BackfillReport> {
  const report: BackfillReport = { embedded: [], unchanged: 0, orphans: [], failed: [] }
  for (const row of store.backfillCandidates()) {
    const raw = readFile(row.filePath)
    if (raw === null) {
      report.orphans.push({ slug: row.slug, filePath: row.filePath })
      continue
    }
    const text = embeddingText(bodyOfNote(raw))
    if (text.length === 0) {
      report.failed.push({ slug: row.slug, reason: 'empty body' })
      continue
    }
    const hash = embeddingTextHash(text)
    if (row.providerId === provider.id && row.textHash === hash) {
      report.unchanged++
      continue
    }
    try {
      const vec = await provider.embed(text)
      store.upsert(row.rowid, provider.id, provider.dims, vec, hash)
      report.embedded.push(row.slug)
      onProgress(row.slug)
    } catch (err) {
      report.failed.push({ slug: row.slug, reason: (err as Error).message })
    }
  }
  return report
}
