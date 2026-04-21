const Database = require('better-sqlite3')
const path = require('path')
const dbPath = process.env.CHODA_DB_PATH || path.join(__dirname, '..', 'choda-deck.db')
const db = new Database(dbPath, { readonly: true })
const sid = process.argv[2]
if (!sid) {
  console.error('usage: diag-session.cjs <sessionId>')
  process.exit(1)
}
console.log('=== sessions row ===')
console.log(db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid))
console.log('\n=== pipeline_approvals ===')
const rows = db
  .prepare('SELECT * FROM pipeline_approvals WHERE session_id = ? ORDER BY created_at')
  .all(sid)
for (const r of rows) console.log(r)
db.close()
