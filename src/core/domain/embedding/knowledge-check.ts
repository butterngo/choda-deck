import { parseFrontmatter } from '../knowledge-frontmatter'
import { embeddingChunks, embeddingTextHash, noteText } from './embedding-backfill'
import type { BackfillCandidate } from './embedding-store'

// TASK-3267 — what `knowledge backfill` and `knowledge_register_existing` would
// trip over, found without writing anything. Each of these drifted silently
// before: 59 rows pointed at deleted files, 14 committed notes had frontmatter
// the parser refuses (search embedded them from a fallback with no excerpt),
// and the live vectors no longer matched their files (TASK-3261).

export interface KnowledgeCheckReport {
  checked: number
  /** The row's file is gone. */
  orphans: Array<{ slug: string; filePath: string }>
  /** The file exists but `parseFrontmatter` refuses it. */
  badFrontmatter: Array<{ slug: string; filePath: string; reason: string }>
  /** The stored vectors are not those of the file under the active provider. */
  stale: Array<{ slug: string; reason: string }>
}

/**
 * Checks every row against its file. `activeProviderId` null = embedding is
 * off, so no row is called stale. `readFile` is async so the MCP boot pass
 * yields between files: a cold read of ~960 notes across repos took 16 s.
 */
export async function runKnowledgeCheck(
  rows: BackfillCandidate[],
  activeProviderId: string | null,
  readFile: (filePath: string) => Promise<string | null>
): Promise<KnowledgeCheckReport> {
  const report: KnowledgeCheckReport = { checked: 0, orphans: [], badFrontmatter: [], stale: [] }
  for (const row of rows) {
    report.checked++
    const raw = await readFile(row.filePath)
    if (raw === null) {
      report.orphans.push({ slug: row.slug, filePath: row.filePath })
      continue
    }
    try {
      parseFrontmatter(raw)
    } catch (err) {
      report.badFrontmatter.push({
        slug: row.slug,
        filePath: row.filePath,
        reason: (err as Error).message
      })
    }
    if (activeProviderId === null) continue
    const reason = staleReason(row, activeProviderId, raw)
    if (reason) report.stale.push({ slug: row.slug, reason })
  }
  return report
}

function staleReason(row: BackfillCandidate, activeProviderId: string, raw: string): string | null {
  if (row.providerId === null) return 'never embedded'
  if (row.providerId !== activeProviderId) return `embedded by ${row.providerId}`
  const { title, body } = noteText(raw, row.title)
  return row.textHash === embeddingTextHash(embeddingChunks(title, body)) ? null : 'file changed'
}

export function knowledgeCheckClean(r: KnowledgeCheckReport): boolean {
  return r.orphans.length === 0 && r.badFrontmatter.length === 0 && r.stale.length === 0
}

export function formatKnowledgeCheck(r: KnowledgeCheckReport): string {
  const lines = [
    `checked ${r.checked} · orphans ${r.orphans.length} · bad frontmatter ${r.badFrontmatter.length} · stale vectors ${r.stale.length}`
  ]
  if (r.orphans.length > 0) {
    lines.push(`orphan rows (file missing) (${r.orphans.length}):`)
    for (const o of r.orphans) lines.push(`  ${o.slug}  ${o.filePath}`)
  }
  if (r.badFrontmatter.length > 0) {
    lines.push(
      `bad frontmatter (knowledge_register_existing refuses these) (${r.badFrontmatter.length}):`
    )
    for (const b of r.badFrontmatter) lines.push(`  ${b.slug}: ${b.reason}  ${b.filePath}`)
  }
  if (r.stale.length > 0) {
    lines.push(`stale vectors (run \`choda-deck knowledge backfill\`) (${r.stale.length}):`)
    for (const s of r.stale) lines.push(`  ${s.slug}: ${s.reason}`)
  }
  return lines.join('\n') + '\n'
}

/** The one stderr line the MCP server prints at boot, or null when all is clean. */
export function knowledgeCheckBootLine(r: KnowledgeCheckReport): string | null {
  if (knowledgeCheckClean(r)) return null
  return (
    `[choda-deck] knowledge check: ${r.orphans.length} orphan rows, ` +
    `${r.badFrontmatter.length} bad frontmatter, ${r.stale.length} stale vectors — ` +
    'run `choda-deck knowledge check` for the list\n'
  )
}

/**
 * Every note in a `docs/knowledge/` folder that `parseFrontmatter` refuses,
 * INDEX.md aside. A vitest test runs this on the repo's own folder so CI fails
 * on a note `knowledge_register_existing` would refuse.
 */
export function noteFrontmatterErrors(
  dir: string,
  list: (dir: string) => string[],
  read: (file: string) => string
): Array<{ file: string; reason: string }> {
  const errors: Array<{ file: string; reason: string }> = []
  const notes = list(dir).filter((f) => f.endsWith('.md') && f !== 'INDEX.md')
  for (const file of notes.sort()) {
    try {
      parseFrontmatter(read(`${dir}/${file}`))
    } catch (err) {
      errors.push({ file, reason: (err as Error).message })
    }
  }
  return errors
}
