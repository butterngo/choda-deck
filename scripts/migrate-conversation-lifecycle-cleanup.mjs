#!/usr/bin/env node
// Cleanup conversations with stale lifecycle timestamps.
// Root cause shipped in TASK-712: prior `reopenConversation` reset status
// without nulling closedAt + decidedAt + decisionSummary, leaving rows in
// inconsistent states. This script normalizes existing data once;
// idempotent — safe to re-run.

import Database from 'better-sqlite3'
import * as path from 'node:path'

const dataDir = process.env.CHODA_DATA_DIR ?? path.resolve('data')
const dbPath = path.join(dataDir, 'database', 'choda-deck.db')

console.log(`Opening DB: ${dbPath}`)
const db = new Database(dbPath)

const findStmt = db.prepare(`
  SELECT id, status, closed_at, decided_at, decision_summary
  FROM conversations
  WHERE (closed_at IS NOT NULL AND status != 'closed')
     OR (decided_at IS NOT NULL AND status NOT IN ('decided', 'closed'))
     OR (decision_summary IS NOT NULL AND status NOT IN ('decided', 'closed'))
`)

const inconsistent = findStmt.all()
console.log(`Found ${inconsistent.length} inconsistent conversation row(s)`)

if (inconsistent.length === 0) {
  console.log('Nothing to migrate.')
  db.close()
  process.exit(0)
}

const updateStmt = db.prepare(`
  UPDATE conversations
  SET closed_at        = CASE WHEN status = 'closed' THEN closed_at ELSE NULL END,
      decided_at       = CASE WHEN status IN ('decided', 'closed') THEN decided_at ELSE NULL END,
      decision_summary = CASE WHEN status IN ('decided', 'closed') THEN decision_summary ELSE NULL END
  WHERE id = ?
`)

let touched = 0
const tx = db.transaction(() => {
  for (const row of inconsistent) {
    const r = updateStmt.run(row.id)
    if (r.changes > 0) touched++
    console.log(`  - ${row.id} (status=${row.status}) cleared stale timestamps`)
  }
})
tx()

console.log(`Migration complete: ${touched} row(s) updated.`)
db.close()
