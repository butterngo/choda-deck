#!/usr/bin/env node
/**
 * Backfill knowledge_index embeddings.
 *
 * Iterates rows whose embedding_provider_id is NULL or differs from the active
 * provider, embeds the body, and populates knowledge_vec + the metadata
 * columns. Idempotent — re-running picks up only what's still pending.
 *
 * Usage:
 *   node scripts/backfill-embeddings.mjs
 *
 * Env:
 *   CHODA_DATA_DIR / CHODA_DB_PATH — DB location (matches MCP server)
 *   CHODA_EMBEDDING_PROVIDER       — local (default) | noop
 *
 * Phase 1: only the local Xenova/all-MiniLM-L6-v2 provider is supported here.
 * Switching providers also triggers an auto-DROP/CREATE of knowledge_vec on
 * the next MCP server startup (see EmbeddingStore.ensureSchema).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { pipeline } from '@huggingface/transformers'

const PROVIDER_ID = 'local-minilm-l6-v2'
const MODEL = 'Xenova/all-MiniLM-L6-v2'
const DIMS = 384

function resolveDbPath() {
  const legacy = process.env.CHODA_DB_PATH
  if (legacy) return path.resolve(legacy)
  const dataDir = process.env.CHODA_DATA_DIR
  if (dataDir) return path.join(path.resolve(dataDir), 'database', 'choda-deck.db')
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  return path.join(path.resolve(__dirname, '..'), 'data', 'database', 'choda-deck.db')
}

function stripFrontmatter(content) {
  if (!content.startsWith('---')) return content.trim()
  const end = content.indexOf('\n---', 3)
  if (end === -1) return content.trim()
  return content.slice(end + 4).replace(/^\r?\n/, '').trim()
}

function ensureVecSchema(db) {
  const existing = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_vec'")
    .get()
  const previousProviderRow = db
    .prepare(
      `SELECT embedding_provider_id AS pid FROM knowledge_index
       WHERE embedding_provider_id IS NOT NULL LIMIT 1`
    )
    .get()
  const previousProvider = previousProviderRow?.pid ?? null

  if (previousProvider && previousProvider !== PROVIDER_ID) {
    console.log(`[backfill] provider mismatch ${previousProvider} → ${PROVIDER_ID}; resetting`)
    db.exec('DROP TABLE IF EXISTS knowledge_vec')
    db.exec('UPDATE knowledge_index SET embedding_provider_id = NULL, embedding_dims = NULL')
  }
  if (!existing || (previousProvider && previousProvider !== PROVIDER_ID)) {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_vec USING vec0(embedding float[${DIMS}])`)
  }
}

async function main() {
  const dbPath = resolveDbPath()
  if (!fs.existsSync(dbPath)) {
    console.error(`[backfill] DB not found at ${dbPath}`)
    process.exit(1)
  }
  console.log(`[backfill] db: ${dbPath}`)

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  sqliteVec.load(db)

  ensureVecSchema(db)

  const pending = db
    .prepare(
      `SELECT rowid AS rowid, slug, file_path AS filePath
       FROM knowledge_index
       WHERE embedding_provider_id IS NULL OR embedding_provider_id <> ?
       ORDER BY created_at ASC`
    )
    .all(PROVIDER_ID)

  if (pending.length === 0) {
    console.log('[backfill] nothing pending — all rows embedded with active provider')
    db.close()
    return
  }

  console.log(`[backfill] ${pending.length} rows pending — loading model`)
  const tStart = Date.now()
  const embed = await pipeline('feature-extraction', MODEL, { quantized: true })
  console.log(`[backfill] model loaded in ${Date.now() - tStart}ms`)

  const insertVec = db.prepare('INSERT INTO knowledge_vec(rowid, embedding) VALUES (?, ?)')
  const deleteVec = db.prepare('DELETE FROM knowledge_vec WHERE rowid = ?')
  const updateMeta = db.prepare(
    'UPDATE knowledge_index SET embedding_provider_id = ?, embedding_dims = ? WHERE rowid = ?'
  )

  const upsertTx = db.transaction((rowid, vecJson) => {
    deleteVec.run(BigInt(rowid))
    insertVec.run(BigInt(rowid), vecJson)
    updateMeta.run(PROVIDER_ID, DIMS, rowid)
  })

  let processed = 0
  let failed = 0
  for (const row of pending) {
    try {
      if (!fs.existsSync(row.filePath)) {
        console.warn(`[backfill] ${row.slug}: file missing at ${row.filePath} — skip`)
        failed++
        continue
      }
      const raw = fs.readFileSync(row.filePath, 'utf8')
      const body = stripFrontmatter(raw)
      if (!body) {
        console.warn(`[backfill] ${row.slug}: empty body — skip`)
        failed++
        continue
      }
      const out = await embed(body, { pooling: 'mean', normalize: true })
      const vecJson = JSON.stringify(Array.from(out.data))
      upsertTx(row.rowid, vecJson)
      processed++
      console.log(`[backfill] ${processed}/${pending.length}  ${row.slug}`)
    } catch (err) {
      failed++
      console.error(`[backfill] ${row.slug}: ${err.message}`)
    }
  }

  db.close()
  console.log(`[backfill] done — processed=${processed} failed=${failed}`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('[backfill] fatal:', err)
  process.exit(1)
})
