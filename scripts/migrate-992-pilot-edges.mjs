// scripts/migrate-992-pilot-edges.mjs
// One-shot migration (TASK-992 / ADR-NNN unified knowledge graph):
// populate the five first-class graph edges that have source data in the
// existing feature/gotcha frontmatter (written by TASK-988's migration) into the
// generic `relationships` table:
//
//   REALIZES  task    → feature    (from feature.realizesTasks)
//   IN        feature → workspace  (from feature.inWorkspaces)
//   ABOUT     gotcha  → feature    (from gotcha.affectedFeatureId)
//
// PINS (knowledge → code_ref) and INTEGRATES_WITH (workspace → workspace) share
// the same table + tool surface but have no frontmatter source yet — nothing to
// backfill, so this script leaves them empty.
//
// Usage:
//   node scripts/migrate-992-pilot-edges.mjs [--dry-run] [--knowledge-dir <path>]
//
// Reads CHODA_DB_PATH / CHODA_DATA_DIR for the DB and CHODA_CONTENT_ROOT for the
// vault. Idempotent: INSERT OR IGNORE on (from_id, to_id, type). Non-destructive
// — only adds edges, never deletes. The `relationships` table is a core table
// present in every DB (no DDL to self-apply, unlike the TASK-988 script).
//
// No shebang line (Windows autocrlf turns it into CRLF and breaks the loader).

import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')

const contentRoot = process.env.CHODA_CONTENT_ROOT ?? 'C:\\Users\\hngo1_mantu\\vault'
const knowledgeDir = argValue('--knowledge-dir') ?? path.join(contentRoot, 'docs', 'knowledge')
const dbPath = resolveDbPath()

const PILOT_FEATURE = 'feature-crawler-list-ui-enhancements'

function argValue(flag) {
  const i = args.indexOf(flag)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null
}

function resolveDbPath() {
  if (process.env.CHODA_DB_PATH) return process.env.CHODA_DB_PATH
  const dataDir = process.env.CHODA_DATA_DIR ?? path.join(process.cwd(), 'data')
  return path.join(dataDir, 'database', 'choda-deck.db')
}

function splitLines(s) {
  return s.split(/\r?\n/)
}

function readMd(slug) {
  const file = path.join(knowledgeDir, `${slug}.md`)
  if (!fs.existsSync(file)) return null
  return fs.readFileSync(file, 'utf8')
}

// `key: value` on a frontmatter line (only scans the leading --- block).
function frontmatterField(raw, key) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return null
  const re = new RegExp(`^${key}:\\s*(.+)$`, 'im')
  const line = m[1].match(re)
  return line ? line[1].trim() : null
}

// Parse a one-line JSON array (`["TASK-909","TASK-910"]`) or comma fallback.
function frontmatterList(raw, key) {
  const v = frontmatterField(raw, key)
  if (!v) return []
  try {
    const parsed = JSON.parse(v)
    if (Array.isArray(parsed)) return parsed.map(String)
  } catch {
    /* fall through */
  }
  return v
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => s.replace(/^["']|["']$/g, '').trim())
    .filter(Boolean)
}

function main() {
  if (!fs.existsSync(dbPath)) {
    console.error(`[992] DB not found at ${dbPath}`)
    process.exit(1)
  }
  if (!fs.existsSync(knowledgeDir)) {
    console.error(`[992] knowledge dir not found at ${knowledgeDir}`)
    process.exit(1)
  }
  console.log(`[992] DB:            ${dbPath}`)
  console.log(`[992] knowledge dir: ${knowledgeDir}`)
  console.log(`[992] mode:          ${dryRun ? 'DRY-RUN (no writes)' : 'APPLY'}\n`)

  const db = new Database(dbPath)
  db.pragma('foreign_keys = ON')

  const rows = db
    .prepare("SELECT slug, type FROM knowledge_index WHERE type IN ('feature','gotcha') ORDER BY slug")
    .all()

  // edge = { from, to, type }
  const edges = []
  for (const row of rows) {
    const raw = readMd(row.slug)
    if (!raw) {
      console.warn(`[992] WARN no .md for ${row.slug} — skipping`)
      continue
    }
    if (row.type === 'feature') {
      for (const taskId of frontmatterList(raw, 'realizesTasks')) {
        edges.push({ from: taskId, to: row.slug, type: 'REALIZES' })
      }
      for (const ws of frontmatterList(raw, 'inWorkspaces')) {
        edges.push({ from: row.slug, to: ws, type: 'IN' })
      }
    } else if (row.type === 'gotcha') {
      const featureId = frontmatterField(raw, 'affectedFeatureId')
      if (featureId) edges.push({ from: row.slug, to: featureId, type: 'ABOUT' })
    }
  }

  const byType = (t) => edges.filter((e) => e.type === t).length
  console.log(
    `[992] derived ${edges.length} edges — REALIZES:${byType('REALIZES')} IN:${byType('IN')} ABOUT:${byType('ABOUT')}\n`
  )
  for (const e of edges) console.log(`  ${e.type.padEnd(9)} ${e.from}  →  ${e.to}`)

  if (!dryRun) {
    const insert = db.prepare(
      'INSERT OR IGNORE INTO relationships (from_id, to_id, type) VALUES (?, ?, ?)'
    )
    const apply = db.transaction(() => {
      for (const e of edges) insert.run(e.from, e.to, e.type)
    })
    apply()
    console.log('\n[992] migration applied.')
  } else {
    console.log('\n[992] dry-run complete — no changes written.')
  }

  reportPilot(db)
  db.close()
}

// AC bullet 3 — the pilot feature must answer the three traversal questions.
function reportPilot(db) {
  const realizes = db
    .prepare("SELECT from_id FROM relationships WHERE to_id = ? AND type = 'REALIZES' ORDER BY from_id")
    .all(PILOT_FEATURE)
    .map((r) => r.from_id)
  const inWs = db
    .prepare("SELECT to_id FROM relationships WHERE from_id = ? AND type = 'IN' ORDER BY to_id")
    .all(PILOT_FEATURE)
    .map((r) => r.to_id)
  const about = db
    .prepare("SELECT from_id FROM relationships WHERE to_id = ? AND type = 'ABOUT' ORDER BY from_id")
    .all(PILOT_FEATURE)
    .map((r) => r.from_id)

  console.log(`\n[992] pilot ${PILOT_FEATURE}:`)
  console.log(`        REALIZES (tasks):     ${realizes.length}  ${realizes.join(', ')}`)
  console.log(`        IN (workspaces):      ${inWs.length}  ${inWs.join(', ')}`)
  console.log(`        ABOUT (gotchas):      ${about.length}  ${about.join(', ')}`)
  const ok = realizes.length === 7 && inWs.length === 2 && about.length === 4
  console.log(`        AC check: ${ok ? 'PASS (7 / 2 / 4)' : 'MISMATCH — expected 7 / 2 / 4'}`)
}

main()
