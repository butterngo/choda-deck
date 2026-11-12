import * as fs from 'fs'
import Database from 'better-sqlite3'
import { EmbeddingStore, type BackfillCandidate } from './embedding-store'
import { resolveProviderKey } from './embedding-provider-factory'
import { LOCAL_PROVIDER_ID } from './local-embedding-provider'
import { runKnowledgeCheck, type KnowledgeCheckReport } from './knowledge-check'

// TASK-3267 — runs the check against a database file, read-only, so neither
// the CLI nor the MCP boot pass can change a row or a file. The rows are read
// and the connection closed before any note is opened.
export async function checkKnowledgeDatabase(dbPath: string): Promise<KnowledgeCheckReport> {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  let rows: BackfillCandidate[]
  try {
    rows = new EmbeddingStore(db, false).backfillCandidates()
  } finally {
    db.close()
  }
  const activeProviderId = resolveProviderKey() === 'noop' ? null : LOCAL_PROVIDER_ID
  return runKnowledgeCheck(rows, activeProviderId, async (p) => {
    try {
      return await fs.promises.readFile(p, 'utf8')
    } catch {
      return null
    }
  })
}
