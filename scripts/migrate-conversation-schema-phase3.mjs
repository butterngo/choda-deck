// TASK-972 Phase 3 — conversation schema narrowing pre-flight inspector.
//
// The actual SQLite migration is embedded in `src/core/domain/repositories/
// schema.ts::migrateConversationSchemaNarrowing` and runs automatically on
// the next MCP server boot. This script is the operator's eyes before that
// boot: it backs the DB up and reports what will change.
//
// Usage:
//   node scripts/migrate-conversation-schema-phase3.mjs [--backup] [--db <path>]
//
// To apply the migration: rebuild the MCP bundle (`pnpm run build:mcp`), then
// `/mcp reconnect` in Claude Code. The embedded migration fires once on the
// first read after reconnect.

import { existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const repoRoot = resolve(__dirname, '..')

function parseArgs(argv) {
  const args = { backup: false, db: null }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--backup') args.backup = true
    else if (a === '--db') args.db = argv[++i]
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: node scripts/migrate-conversation-schema-phase3.mjs [--backup] [--db <path>]\n' +
          '\n' +
          '  --backup    copy DB to data/backups/pre-task-972-<timestamp>.db before reporting\n' +
          '  --db <path> override DB path (default: data/database/choda-deck.db)\n' +
          '\n' +
          'This script only inspects + optionally backs up. The actual migration runs\n' +
          'on the next MCP server boot (rebuild + /mcp reconnect).'
      )
      process.exit(0)
    }
  }
  return args
}

const { backup, db: dbOverride } = parseArgs(process.argv)
const dbPath =
  dbOverride ??
  process.env.CHODA_DB_PATH ??
  join(repoRoot, 'data', 'database', 'choda-deck.db')

if (!existsSync(dbPath)) {
  console.error(`ERR: DB not found at ${dbPath}`)
  process.exit(2)
}

const Database = (await import('better-sqlite3')).default
const db = new Database(dbPath, { readonly: true })

console.log(`DB: ${dbPath}`)
console.log()

const convCols = db.pragma('table_info(conversations)')
const partCols = db.pragma('table_info(conversation_participants)')
const msgCols = db.pragma('table_info(conversation_messages)')

const colNames = (rows) => new Set(rows.map((r) => r.name))

const oldFields = {
  'conversations.closed_at': colNames(convCols).has('closed_at'),
  'conversation_participants.participant_type': colNames(partCols).has('participant_type'),
  'conversation_participants.participant_role': colNames(partCols).has('participant_role'),
  'conversation_messages.message_type': colNames(msgCols).has('message_type'),
  'conversation_messages.metadata_json': colNames(msgCols).has('metadata_json'),
  'conversation_messages.target_role': colNames(msgCols).has('target_role')
}
const hasSignedOff = colNames(convCols).has('signed_off_json')
const hasReadsTable = !!db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_message_reads'")
  .get()

console.log('Schema state:')
for (const [key, present] of Object.entries(oldFields)) {
  console.log(`  ${present ? '✗' : '✓'} ${key}: ${present ? 'still exists (will drop)' : 'gone'}`)
}
console.log(
  `  ${hasSignedOff ? '✓' : '✗'} conversations.signed_off_json: ${
    hasSignedOff ? 'present' : 'missing (will add)'
  }`
)
console.log(
  `  ${hasReadsTable ? '✓' : '✗'} conversation_message_reads table: ${
    hasReadsTable ? 'present' : 'missing (will create)'
  }`
)
console.log()

let statusRows = []
try {
  statusRows = db.prepare('SELECT status, COUNT(*) AS n FROM conversations GROUP BY status').all()
} catch {
  // conversations table absent on a brand-new DB — nothing to migrate.
}
const oldStatusCount = statusRows
  .filter((r) => r.status === 'discussing' || r.status === 'closed' || r.status === 'stale')
  .reduce((a, b) => a + b.n, 0)

console.log('Conversation status distribution:')
for (const row of statusRows) {
  const willMap =
    row.status === 'discussing'
      ? '→ open'
      : row.status === 'closed' || row.status === 'stale'
      ? '→ decided'
      : ''
  console.log(`  ${row.status.padEnd(12)} ${String(row.n).padStart(6)}  ${willMap}`)
}
console.log(`Rows requiring status migration: ${oldStatusCount}`)
console.log()

const hasOldFields = Object.values(oldFields).some(Boolean)
const nothingToDo = !hasOldFields && hasSignedOff && hasReadsTable && oldStatusCount === 0

if (nothingToDo) {
  console.log('No migration needed — schema already at target shape.')
  db.close()
  process.exit(0)
}

if (backup) {
  const backupDir = join(dirname(dbPath), '..', 'backups')
  mkdirSync(backupDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = join(backupDir, `pre-task-972-${stamp}.db`)
  copyFileSync(dbPath, backupPath)
  console.log(`Backup written: ${backupPath}`)
  console.log()
}

console.log('To apply: `pnpm run build:mcp` then `/mcp reconnect` — the embedded')
console.log('migration in schema.ts runs on the first read after reconnect.')

db.close()
