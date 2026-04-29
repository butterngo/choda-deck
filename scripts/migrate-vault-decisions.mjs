#!/usr/bin/env node
// One-shot migration: 16 ADR + 1 spike từ vault sang docs/knowledge/ + index DB
// + bonus: index ADR-018 đã exist trong repo (loose end của TASK-634)
// Phase 2 of TASK-634. Refs:[] cho tất cả — add khi touch ADR sau.

import * as fs from 'node:fs'
import * as path from 'node:path'
import Database from 'better-sqlite3'

const REPO_ROOT = 'C:\\dev\\choda-deck'
const VAULT_DIR = 'C:\\Users\\hngo1_mantu\\vault\\10-Projects\\choda-deck\\docs\\decisions'
const KNOWLEDGE_DIR = path.join(REPO_ROOT, 'docs', 'knowledge')
const DB_PATH = path.join(REPO_ROOT, 'data', 'database', 'choda-deck.db')
const TODAY = '2026-04-29'
const PROJECT_ID = 'choda-deck'

function parseOldFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) return { fm: {}, body: raw }
  const fm = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/)
    if (kv) fm[kv[1]] = kv[2].trim()
  }
  return { fm, body: m[2] ?? '' }
}

function findH1(body) {
  const m = body.match(/^#\s+(.+)$/m)
  return m ? m[1].trim() : null
}

function unquote(v) {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return JSON.parse(v)
  return v
}

function quoteIfNeeded(s) {
  if (/[:#\[\]{}|>&*!%@`]/.test(s) || s !== s.trim()) return JSON.stringify(s)
  return s
}

function serializeFrontmatter(fm, body) {
  const lines = ['---']
  lines.push(`type: ${fm.type}`)
  lines.push(`title: ${quoteIfNeeded(fm.title)}`)
  lines.push(`projectId: ${fm.projectId}`)
  lines.push(`scope: ${fm.scope}`)
  lines.push('refs: []')
  lines.push(`createdAt: ${fm.createdAt}`)
  lines.push(`lastVerifiedAt: ${fm.lastVerifiedAt}`)
  lines.push('---')
  const trimmed = body.replace(/^\r?\n+/, '')
  return lines.join('\n') + '\n\n' + trimmed + (trimmed.endsWith('\n') ? '' : '\n')
}

function regenerateIndex(db, projectCwd) {
  const rows = db
    .prepare(
      `SELECT slug, type, title, last_verified_at FROM knowledge_index
       WHERE project_id = ? AND scope = 'project' ORDER BY created_at DESC`
    )
    .all(PROJECT_ID)
  const indexPath = path.join(projectCwd, 'docs', 'knowledge', 'INDEX.md')
  const lines = [`# Knowledge — ${PROJECT_ID}`, '']
  if (rows.length === 0) {
    lines.push('_No entries yet._')
  } else {
    lines.push('| Slug | Type | Title | Last verified | Stale |')
    lines.push('|------|------|-------|---------------|-------|')
    for (const r of rows) {
      lines.push(
        `| [${r.slug}](./${r.slug}.md) | ${r.type} | ${r.title.replace(/\|/g, '\\|')} | ${r.last_verified_at.slice(0, 10)} |  |`
      )
    }
  }
  lines.push('')
  fs.writeFileSync(indexPath, lines.join('\n') + '\n', 'utf8')
}

const upsertStmt = (db) =>
  db.prepare(
    `INSERT INTO knowledge_index (slug, project_id, scope, type, title, file_path, created_at, last_verified_at)
     VALUES (?, ?, 'project', ?, ?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET
       project_id = excluded.project_id,
       scope = excluded.scope,
       type = excluded.type,
       title = excluded.title,
       file_path = excluded.file_path,
       last_verified_at = excluded.last_verified_at`
  )

function migrateFile(db, upsert, filename) {
  const srcPath = path.join(VAULT_DIR, filename)
  const slug = filename.replace(/\.md$/, '')
  const type = filename.startsWith('ADR-') ? 'decision' : 'spike'
  const raw = fs.readFileSync(srcPath, 'utf8')
  const { fm: oldFm, body: oldBody } = parseOldFrontmatter(raw)

  let title = oldFm.title ? unquote(oldFm.title) : findH1(oldBody) ?? slug
  const createdAt = oldFm.date || TODAY

  const dstPath = path.join(KNOWLEDGE_DIR, filename)
  if (fs.existsSync(dstPath)) {
    console.log(`  SKIP write (exists): ${filename}`)
  } else {
    const content = serializeFrontmatter(
      { type, title, projectId: PROJECT_ID, scope: 'project', createdAt, lastVerifiedAt: TODAY },
      oldBody
    )
    fs.writeFileSync(dstPath, content, 'utf8')
    console.log(`  WROTE ${filename}`)
  }

  upsert.run(slug, PROJECT_ID, type, title, dstPath, createdAt, TODAY)
  console.log(`  INDEXED ${slug}  type=${type} createdAt=${createdAt}`)
}

function indexExisting(db, upsert, filename) {
  const filePath = path.join(KNOWLEDGE_DIR, filename)
  const slug = filename.replace(/\.md$/, '')
  const raw = fs.readFileSync(filePath, 'utf8')
  const { fm } = parseOldFrontmatter(raw)
  const title = fm.title ? unquote(fm.title) : slug
  const type = fm.type || (filename.startsWith('ADR-') ? 'decision' : 'spike')
  const createdAt = fm.createdAt || TODAY
  const lastVerifiedAt = fm.lastVerifiedAt || TODAY

  upsert.run(slug, PROJECT_ID, type, title, filePath, createdAt, lastVerifiedAt)
  console.log(`  INDEXED ${slug}  (existing file in repo)`)
}

function main() {
  if (!fs.existsSync(KNOWLEDGE_DIR)) fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true })
  if (!fs.existsSync(DB_PATH)) {
    console.error(`DB not found: ${DB_PATH}`)
    process.exit(1)
  }
  if (!fs.existsSync(VAULT_DIR)) {
    console.error(`Vault decisions dir not found: ${VAULT_DIR}`)
    process.exit(1)
  }

  const db = new Database(DB_PATH)
  const upsert = upsertStmt(db)

  const files = fs.readdirSync(VAULT_DIR).filter((f) => f.endsWith('.md'))
  console.log(`\n=== Phase 1: migrate ${files.length} files from vault ===`)

  const tx = db.transaction(() => {
    for (const f of files) migrateFile(db, upsert, f)
    console.log(`\n=== Phase 2: index existing ADR-018 in repo ===`)
    indexExisting(db, upsert, 'ADR-018-knowledge-layer.md')
  })
  tx()

  console.log(`\n=== Phase 3: regenerate INDEX.md ===`)
  regenerateIndex(db, REPO_ROOT)
  console.log('  Regenerated.')

  const total = db.prepare('SELECT COUNT(*) as n FROM knowledge_index').get().n
  console.log(`\nDONE — ${total} rows in knowledge_index.`)

  db.close()
}

main()
