#!/usr/bin/env node
/**
 * One-shot backfill — index existing workflow-engine ADRs under
 * project=automation-rule, workspace=workflow-engine.
 *
 * Per ADR-022 (TASK-651). Steps per file:
 *   1. Read + parse frontmatter.
 *   2. If projectId == 'workflow-engine' (legacy), rewrite to:
 *        projectId: automation-rule
 *        workspaceId: workflow-engine
 *      and write back to disk.
 *   3. Upsert into knowledge_index with workspace_id='workflow-engine'.
 *
 * Idempotent — re-run is safe (frontmatter step is a no-op once rewritten;
 * upsert uses ON CONFLICT on slug).
 *
 * Usage:
 *   node scripts/ingest-automation-rule-workflow-engine.mjs [--dry-run]
 *
 * Env: CHODA_DATA_DIR / CHODA_DB_PATH — DB location (matches MCP server).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const SOURCE_DIR = 'C:\\dev\\test\\workflow-engine\\docs\\knowledge'
const PROJECT_ID = 'automation-rule'
const WORKSPACE_ID = 'workflow-engine'
const LEGACY_PROJECT_ID = 'workflow-engine'

function resolveDbPath() {
  const legacy = process.env.CHODA_DB_PATH
  if (legacy) return path.resolve(legacy)
  const dataDir = process.env.CHODA_DATA_DIR
  if (dataDir) return path.join(path.resolve(dataDir), 'database', 'choda-deck.db')
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  return path.join(path.resolve(__dirname, '..'), 'data', 'database', 'choda-deck.db')
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

function parseFrontmatter(raw) {
  const m = raw.match(FRONTMATTER_RE)
  if (!m) throw new Error('missing --- frontmatter delimiters')
  const fmText = m[1]
  const body = m[2] ?? ''
  const fm = { refs: [] }
  const lines = fmText.split(/\r?\n/)
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      i++
      continue
    }
    if (line.startsWith('refs:')) {
      const rest = line.slice('refs:'.length).trim()
      if (rest === '[]') {
        fm.refs = []
        i++
        continue
      }
      i++
      while (i < lines.length) {
        const l = lines[i]
        if (/^\s*-\s/.test(l) || /^\s{4,}\w/.test(l) || l.trim() === '') {
          i++
          continue
        }
        break
      }
      continue
    }
    const kv = line.match(/^([a-zA-Z]+):\s*(.*)$/)
    if (!kv) throw new Error(`unrecognized frontmatter line: ${line}`)
    fm[kv[1]] = unquote(kv[2].trim())
    i++
  }
  return { fm, body, fmText, raw }
}

function unquote(v) {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return JSON.parse(v)
  }
  return v
}

function rewriteFrontmatterInPlace(raw, fm) {
  const m = raw.match(FRONTMATTER_RE)
  if (!m) throw new Error('cannot rewrite — no frontmatter')
  const orig = m[1]
  let next = orig
  if (fm.projectId === LEGACY_PROJECT_ID) {
    next = next.replace(/^projectId:\s*workflow-engine\s*$/m, `projectId: ${PROJECT_ID}`)
    if (!/^workspaceId:/m.test(next)) {
      next = next.replace(
        new RegExp(`^projectId: ${PROJECT_ID}\\s*$`, 'm'),
        `projectId: ${PROJECT_ID}\nworkspaceId: ${WORKSPACE_ID}`
      )
    }
  }
  if (next === orig) return null
  return raw.replace(orig, next)
}

function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const dbPath = resolveDbPath()
  if (!fs.existsSync(dbPath)) {
    console.error(`[ingest] DB not found at ${dbPath}`)
    process.exit(1)
  }
  console.log(`[ingest] db: ${dbPath}`)
  console.log(`[ingest] source: ${SOURCE_DIR}`)
  console.log(`[ingest] dry-run: ${dryRun}`)

  if (!fs.existsSync(SOURCE_DIR)) {
    console.error(`[ingest] source directory missing: ${SOURCE_DIR}`)
    process.exit(1)
  }

  const db = new Database(dbPath)
  db.pragma('foreign_keys = ON')

  // Verify project + workspace exist.
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(PROJECT_ID)
  if (!project) {
    console.error(`[ingest] project ${PROJECT_ID} not found in DB`)
    process.exit(1)
  }
  const workspace = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(WORKSPACE_ID)
  if (!workspace) {
    console.error(`[ingest] workspace ${WORKSPACE_ID} not found in DB`)
    process.exit(1)
  }

  // Verify the migration ran.
  const cols = db.pragma('table_info(knowledge_index)')
  if (!cols.some((c) => c.name === 'workspace_id')) {
    console.error('[ingest] knowledge_index.workspace_id column missing — run latest schema first')
    process.exit(1)
  }

  const files = fs
    .readdirSync(SOURCE_DIR)
    .filter((f) => f.startsWith('ADR-') && f.endsWith('.md'))
    .sort()

  console.log(`[ingest] found ${files.length} ADR files`)

  const upsert = db.prepare(
    `INSERT INTO knowledge_index
       (slug, project_id, workspace_id, scope, type, title, file_path, created_at, last_verified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET
       project_id = excluded.project_id,
       workspace_id = excluded.workspace_id,
       scope = excluded.scope,
       type = excluded.type,
       title = excluded.title,
       file_path = excluded.file_path,
       last_verified_at = excluded.last_verified_at`
  )

  let rewritten = 0
  let indexed = 0
  let skipped = 0

  for (const file of files) {
    const fp = path.join(SOURCE_DIR, file)
    try {
      const raw = fs.readFileSync(fp, 'utf8')
      const { fm } = parseFrontmatter(raw)

      // Step 1 — frontmatter rewrite (idempotent: returns null if no change needed).
      const rewroteRaw = rewriteFrontmatterInPlace(raw, fm)
      let effectiveFm = fm
      if (rewroteRaw) {
        if (!dryRun) fs.writeFileSync(fp, rewroteRaw, 'utf8')
        rewritten++
        effectiveFm = parseFrontmatter(rewroteRaw).fm
        console.log(`[ingest] rewrote frontmatter: ${file}`)
      }

      // Step 2 — guard: after rewrite the projectId must match.
      if (effectiveFm.projectId !== PROJECT_ID) {
        console.warn(
          `[ingest] ${file}: projectId=${effectiveFm.projectId} unexpected — skipping`
        )
        skipped++
        continue
      }

      // Step 3 — index.
      const slug = path.basename(file, '.md')
      if (!dryRun) {
        upsert.run(
          slug,
          PROJECT_ID,
          WORKSPACE_ID,
          effectiveFm.scope ?? 'project',
          effectiveFm.type ?? 'decision',
          effectiveFm.title ?? slug,
          fp,
          effectiveFm.createdAt ?? new Date().toISOString().slice(0, 10),
          effectiveFm.lastVerifiedAt ?? new Date().toISOString().slice(0, 10)
        )
      }
      indexed++
      console.log(`[ingest] ${indexed}/${files.length}  ${slug}`)
    } catch (err) {
      console.error(`[ingest] ${file}: ${err.message}`)
      skipped++
    }
  }

  db.close()
  console.log(
    `[ingest] done — rewritten=${rewritten} indexed=${indexed} skipped=${skipped}` +
      (dryRun ? ' (dry-run)' : '')
  )
  process.exit(skipped === 0 ? 0 : 1)
}

main()
