// POC: sqlite-vec + @xenova/transformers for semantic search on knowledge_index.
//
// Validates:
//   1. sqlite-vec extension loads in better-sqlite3 on Windows + plain Node
//   2. @xenova/transformers generates embeddings without OPENAI_API_KEY
//   3. vec0 virtual table KNN query returns the right neighbour for a paraphrased query
//
// Run: node scripts/poc-sqlite-vec.mjs

import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { pipeline } from '@huggingface/transformers'

const MODEL = 'Xenova/all-MiniLM-L6-v2'
const DIMS = 384

const SAMPLES = [
  { id: 'adr-007', text: 'Choda Deck replaces Obsidian as primary knowledge layer.' },
  { id: 'adr-009', text: 'Session lifecycle: start, work, checkpoint, end with handoff.' },
  { id: 'adr-010', text: 'Conversation protocol for multi-role async dialog with decisions.' },
  { id: 'adr-012', text: 'Daily SQLite backup with retention rotation and restore command.' },
  { id: 'adr-018', text: 'Knowledge layer with frontmatter, refs, and staleness verification via git SHA pinning.' },
]

const QUERY = 'how do we keep documentation fresh when code changes'

function timer(label) {
  const start = process.hrtime.bigint()
  return () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6
    console.log(`[${label}] ${ms.toFixed(0)}ms`)
  }
}

async function main() {
  // 1. Open db + load vec extension
  const tDb = timer('db open + vec load')
  const db = new Database(':memory:')
  sqliteVec.load(db)
  const { vec_version } = db.prepare('SELECT vec_version() AS vec_version').get()
  tDb()
  console.log(`sqlite-vec version: ${vec_version}`)

  // 2. Load embedding model (downloads to ~/.cache/huggingface on first run)
  const tModel = timer('model load')
  const embed = await pipeline('feature-extraction', MODEL, { quantized: true })
  tModel()

  // 3. Create vec0 virtual table
  db.exec(`
    CREATE VIRTUAL TABLE knowledge_vec USING vec0(
      embedding float[${DIMS}]
    );
    CREATE TABLE knowledge_meta (rowid INTEGER PRIMARY KEY, slug TEXT NOT NULL, body TEXT NOT NULL);
  `)

  // 4. Embed + insert samples
  const insertVec = db.prepare('INSERT INTO knowledge_vec(rowid, embedding) VALUES (?, ?)')
  const insertMeta = db.prepare('INSERT INTO knowledge_meta(rowid, slug, body) VALUES (?, ?, ?)')

  const tEmbed = timer(`embed ${SAMPLES.length} samples`)
  for (let i = 0; i < SAMPLES.length; i++) {
    const s = SAMPLES[i]
    const out = await embed(s.text, { pooling: 'mean', normalize: true })
    const vec = JSON.stringify(Array.from(out.data))
    insertVec.run(BigInt(i + 1), vec)
    insertMeta.run(i + 1, s.id, s.text)
  }
  tEmbed()

  // 5. KNN query
  const tQuery = timer('embed + KNN query')
  const qOut = await embed(QUERY, { pooling: 'mean', normalize: true })
  const qVec = JSON.stringify(Array.from(qOut.data))

  const rows = db
    .prepare(
      `SELECT m.slug, m.body, v.distance
       FROM knowledge_vec v
       JOIN knowledge_meta m ON m.rowid = v.rowid
       WHERE v.embedding MATCH ? AND k = 3
       ORDER BY v.distance`
    )
    .all(qVec)
  tQuery()

  console.log(`\nQuery: "${QUERY}"`)
  console.log('Top 3:')
  for (const r of rows) {
    console.log(`  ${r.slug}  d=${r.distance.toFixed(4)}  — ${r.body}`)
  }

  // Expected: adr-018 (staleness verification) ranks first.
  const top = rows[0]?.slug
  console.log(`\nExpected top match: adr-018 (staleness)`)
  console.log(`Actual top match:   ${top}`)
  console.log(top === 'adr-018' ? 'POC PASS' : 'POC FAIL')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
