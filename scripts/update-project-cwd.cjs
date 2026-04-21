// One-shot fix: project.cwd for choda-deck pointed at vault by mistake.
// Run via electron-as-node so better-sqlite3 ABI matches MCP server.
const Database = require('better-sqlite3')
const path = require('path')

const dbPath = process.env.CHODA_DB_PATH || path.join(__dirname, '..', 'choda-deck.db')
const db = new Database(dbPath)
const result = db
  .prepare('UPDATE projects SET cwd = ? WHERE id = ?')
  .run('C:\\dev\\choda-deck', 'choda-deck')
console.log(`updated ${result.changes} row(s)`)
const row = db.prepare('SELECT id, cwd FROM projects WHERE id = ?').get('choda-deck')
console.log('after:', row)
db.close()
