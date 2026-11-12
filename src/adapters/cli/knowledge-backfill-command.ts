import * as fs from 'fs'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { initSchema } from '../../core/domain/repositories/schema'
import { EmbeddingStore } from '../../core/domain/embedding/embedding-store'
import { loadEmbeddingProvider } from '../../core/domain/embedding/embedding-provider-factory'
import {
  runEmbeddingBackfill,
  type BackfillReport
} from '../../core/domain/embedding/embedding-backfill'
import { resolveDataPaths } from '../../core/paths'

// TASK-3261 — `choda-deck knowledge backfill`. Replaces the logic that lived in
// scripts/backfill-embeddings.mjs, which restated the provider id and the
// pipeline options and drifted from the provider (TASK-3203).
//
// Exit codes: 0 every row with a file is embedded (orphans are reported, not
// failures) · 1 a row with a file could not be embedded, or embedding is off.

export function formatBackfillReport(r: BackfillReport): string {
  const lines = [
    `embedded ${r.embedded.length} · unchanged ${r.unchanged} · orphans ${r.orphans.length} · failed ${r.failed.length}`
  ]
  if (r.orphans.length > 0) {
    lines.push(`orphan rows (file missing, not embedded, not deleted) (${r.orphans.length}):`)
    for (const o of r.orphans) lines.push(`  ${o.slug}  ${o.filePath}`)
  }
  if (r.failed.length > 0) {
    lines.push(`failed (${r.failed.length}):`)
    for (const f of r.failed) lines.push(`  ${f.slug}: ${f.reason}`)
  }
  return lines.join('\n') + '\n'
}

export async function knowledgeBackfillCommand(
  io: { out: (s: string) => void; err: (s: string) => void },
  dbPath: string = resolveDataPaths().dbPath
): Promise<number> {
  const db = new Database(dbPath)
  try {
    db.pragma('journal_mode = WAL')
    sqliteVec.load(db)
    initSchema(db)
    const provider = await loadEmbeddingProvider()
    const store = new EmbeddingStore(db, true)
    store.ensureSchema(provider)
    if (!store.isEnabled() || provider.id === 'noop') {
      io.err(`embedding is disabled (provider ${provider.id})\n`)
      return 1
    }
    io.out(`db: ${dbPath}\nprovider: ${provider.id}\n`)
    const report = await runEmbeddingBackfill(
      store,
      provider,
      (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null),
      (slug) => io.out(`embedded ${slug}\n`)
    )
    io.out(formatBackfillReport(report))
    return report.failed.length === 0 ? 0 : 1
  } finally {
    db.close()
  }
}
