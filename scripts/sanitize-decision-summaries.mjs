import { execFileSync } from 'child_process'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const electron = resolve(root, 'node_modules/electron/dist/electron.exe')

const runner = `
const Database = require('better-sqlite3')
const path = require('path')

const dbPath = process.env.CHODA_DB_PATH
  || path.join(process.env.CHODA_DATA_DIR || path.join(process.cwd(), 'data'), 'database', 'choda-deck.db')

const LEAK_MARKERS = [
  '</resumePoint>',
  '<parameter name',
  '<parameter ',
  '<invoke ',
  '<invoke>',
  '</invoke>',
  '<',
  '</',
  '<function_calls>',
  '</function_calls>'
]

function stripToolCallLeak(text) {
  if (!text) return ''
  let earliest = -1
  for (const marker of LEAK_MARKERS) {
    const idx = text.indexOf(marker)
    if (idx !== -1 && (earliest === -1 || idx < earliest)) earliest = idx
  }
  if (earliest === -1) return text
  return text.slice(0, earliest).trimEnd()
}

const db = new Database(dbPath)
const dry = process.env.SANITIZE_DRY_RUN === '1'
console.log('[sanitize] db:', dbPath, dry ? '(dry-run)' : '(writing)')

const rows = db.prepare('SELECT id, decision_summary FROM conversations WHERE decision_summary IS NOT NULL').all()
const update = db.prepare('UPDATE conversations SET decision_summary = ? WHERE id = ?')

let changed = 0
for (const row of rows) {
  const clean = stripToolCallLeak(row.decision_summary)
  if (clean !== row.decision_summary) {
    changed++
    console.log('[sanitize]', row.id, '—', row.decision_summary.length, '→', clean.length, 'chars')
    if (!dry) update.run(clean || 'Session ended', row.id)
  }
}

console.log('[sanitize] done —', changed, 'row(s)', dry ? 'would be' : 'were', 'sanitized')
db.close()
`

const dryRun = process.argv.includes('--dry-run')

execFileSync(electron, ['-e', runner], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    SANITIZE_DRY_RUN: dryRun ? '1' : '0'
  }
})
