// scripts/migrate-988-pilot-proxies.mjs
// One-shot migration (TASK-988 / ADR-NNN unified knowledge graph):
// retype the 11 PIM pilot proxy entries from their decision/learning proxies to
// the real first-class types (feature / code_ref / gotcha), populate the
// code_refs + task_code_refs tables from the markdown Anchor sections + TOUCHES
// tables, and strip the now-redundant `> kind: …` blockquote markers from each
// .md body.
//
// Usage:
//   node scripts/migrate-988-pilot-proxies.mjs [--dry-run] [--knowledge-dir <path>]
//
// Reads CHODA_DB_PATH / CHODA_DATA_DIR for the DB and CHODA_CONTENT_ROOT for the
// vault. Idempotent: re-running is a no-op (rows already retyped are skipped,
// edges upsert). Does NOT delete any entry — all 11 rows survive.
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
const NOW = new Date().toISOString().slice(0, 10)

function argValue(flag) {
  const i = args.indexOf(flag)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null
}

function resolveDbPath() {
  if (process.env.CHODA_DB_PATH) return process.env.CHODA_DB_PATH
  const dataDir = process.env.CHODA_DATA_DIR ?? path.join(process.cwd(), 'data')
  return path.join(dataDir, 'database', 'choda-deck.db')
}

const KIND_TO_TYPE = {
  'feature-spec': 'feature',
  'code-ref': 'code_ref',
  gotcha: 'gotcha'
}

function splitLines(s) {
  return s.split(/\r?\n/)
}

// Mirror of the TASK-988 DDL in src/core/domain/repositories/schema.ts. The
// production path runs that via initSchema on server boot; this standalone
// script may hit a DB that hasn't booted the new code yet, so it self-applies.
// Idempotent — CREATE IF NOT EXISTS + a CHECK-rebuild guarded on the live SQL.
function ensureSchema(db) {
  // Widen the knowledge_index type CHECK if it predates the new types.
  const ki = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='knowledge_index'")
    .get()
  if (ki?.sql && !ki.sql.includes("'feature'")) {
    const cols = db.pragma('table_info(knowledge_index)').map((c) => c.name).join(', ')
    db.exec(`
      CREATE TABLE knowledge_index_new (
        slug TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        scope TEXT NOT NULL CHECK (scope IN ('project','cross')),
        type TEXT NOT NULL CHECK (type IN ('spike','decision','postmortem','learning','evaluation','feature','code_ref','gotcha')),
        title TEXT NOT NULL,
        file_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_verified_at TEXT NOT NULL,
        embedding_provider_id TEXT,
        embedding_dims INTEGER,
        workspace_id TEXT REFERENCES workspaces(id),
        FOREIGN KEY (project_id) REFERENCES projects(id)
      )
    `)
    db.exec(`INSERT INTO knowledge_index_new (${cols}) SELECT ${cols} FROM knowledge_index`)
    db.exec('DROP TABLE knowledge_index')
    db.exec('ALTER TABLE knowledge_index_new RENAME TO knowledge_index')
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS code_refs (
      slug TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      workspace_id TEXT,
      path TEXT NOT NULL,
      symbol TEXT,
      line_hint INTEGER,
      commit_sha TEXT,
      created_at TEXT NOT NULL,
      last_verified_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    )
  `)
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_code_refs_identity ON code_refs(project_id, path, COALESCE(symbol, ''))"
  )
  db.exec('CREATE INDEX IF NOT EXISTS idx_code_refs_symbol ON code_refs(project_id, symbol)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_code_refs_path ON code_refs(project_id, path)')
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_code_refs (
      task_id TEXT NOT NULL,
      code_ref_slug TEXT NOT NULL,
      relation TEXT NOT NULL CHECK (relation IN ('modifies','reference')),
      PRIMARY KEY (task_id, code_ref_slug),
      FOREIGN KEY (code_ref_slug) REFERENCES code_refs(slug)
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_task_code_refs_task ON task_code_refs(task_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_task_code_refs_slug ON task_code_refs(code_ref_slug)')
}

function readMd(slug) {
  const file = path.join(knowledgeDir, `${slug}.md`)
  if (!fs.existsSync(file)) return null
  return { file, raw: fs.readFileSync(file, 'utf8') }
}

function detectKind(body) {
  const m = body.match(/^>\s*kind:\s*([a-z-]+)/im)
  return m ? m[1] : null
}

// `- **Label:** `value`` or `- **Label:** value`
function field(body, label) {
  const re = new RegExp(`^- \\*\\*${label}:\\*\\*\\s*\`?([^\`\\n]+?)\`?\\s*$`, 'im')
  const m = body.match(re)
  return m ? m[1].trim() : null
}

// `> label: value`
function markerField(body, label) {
  const re = new RegExp(`^>\\s*${label}:\\s*(.+)$`, 'im')
  const m = body.match(re)
  return m ? m[1].trim() : null
}

function parseSymbol(body) {
  const raw = field(body, 'Full dotted symbol')
  if (!raw) return null
  if (/null/i.test(raw)) return null
  return raw
}

function parseLineHint(body) {
  const raw = field(body, 'Line \\(hint\\)')
  if (!raw) return null
  const m = raw.match(/(\d+)/)
  return m ? parseInt(m[1], 10) : null
}

// Parse a `## TOUCHES edges` markdown table → [{taskId, relation}].
// Relation cell may be wrapped in ** (e.g. **reference**) and followed by text.
function parseTouches(body) {
  const out = []
  for (const line of splitLines(body)) {
    const m = line.match(/^\|\s*(TASK-\d+)\s*\|\s*\*{0,2}(modifies|reference)\b/i)
    if (m) out.push({ taskId: m[1], relation: m[2].toLowerCase() })
  }
  return out
}

function sectionBody(body, heading) {
  const lines = splitLines(body)
  const start = lines.findIndex((l) => new RegExp(`^#{1,4}\\s*${heading}\\b`, 'i').test(l))
  if (start < 0) return null
  const rest = []
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,4}\s/.test(lines[i])) break
    rest.push(lines[i])
  }
  return rest.join('\n')
}

function parseFeature(body) {
  const anchorTaskId = markerField(body, 'anchor_task')
  const realizesBlock = sectionBody(body, 'Realizes tasks') ?? ''
  const realizes = [...new Set([...realizesBlock.matchAll(/`?(TASK-\d+)`?/g)].map((m) => m[1]))]
  const wsBlock = sectionBody(body, 'In workspaces') ?? ''
  const inWorkspaces = [...new Set([...wsBlock.matchAll(/`([a-z0-9-]+)`/gi)].map((m) => m[1]))]
  const effortRaw = sectionBody(body, 'Effort band') ?? ''
  const effortMatch = effortRaw.match(/\*\*([SMLX]+)\*\*/)
  const effortBand = effortMatch && ['S', 'M', 'L', 'XL'].includes(effortMatch[1])
    ? effortMatch[1]
    : undefined
  return {
    anchorTaskId: anchorTaskId ?? undefined,
    realizesTasks: realizes.length ? realizes : undefined,
    inWorkspaces: inWorkspaces.length ? inWorkspaces : undefined,
    effortBand,
    status: 'blocked' // pilot feature is blocked on upstream capture (see body)
  }
}

// Strip the leading `> kind: …` blockquote block after the frontmatter.
function stripKindBlock(raw) {
  const fmMatch = raw.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n?)([\s\S]*)$/)
  if (!fmMatch) return raw
  const fm = fmMatch[1]
  const lines = splitLines(fmMatch[2])
  let i = 0
  while (i < lines.length && lines[i].trim() === '') i++
  if (i < lines.length && /^>\s*kind:/i.test(lines[i])) {
    while (i < lines.length && /^>/.test(lines[i])) i++
    while (i < lines.length && lines[i].trim() === '') i++
  }
  return fm + lines.slice(i).join('\n')
}

function rewriteFrontmatter(raw, newType, structured) {
  let out = raw.replace(/^type:\s*.+$/im, `type: ${newType}`)
  if (!structured) return out
  const inserts = []
  if (structured.anchorTaskId) inserts.push(`anchorTaskId: ${structured.anchorTaskId}`)
  if (structured.realizesTasks?.length)
    inserts.push(`realizesTasks: ${JSON.stringify(structured.realizesTasks)}`)
  if (structured.inWorkspaces?.length)
    inserts.push(`inWorkspaces: ${JSON.stringify(structured.inWorkspaces)}`)
  if (structured.effortBand) inserts.push(`effortBand: ${structured.effortBand}`)
  if (structured.status) inserts.push(`status: ${structured.status}`)
  if (structured.affectedFeatureId)
    inserts.push(`affectedFeatureId: ${structured.affectedFeatureId}`)
  if (!inserts.length) return out
  out = out.replace(/^(lastVerifiedAt:\s*.+)$/im, `$1\n${inserts.join('\n')}`)
  return out
}

function main() {
  if (!fs.existsSync(dbPath)) {
    console.error(`[988] DB not found at ${dbPath}`)
    process.exit(1)
  }
  if (!fs.existsSync(knowledgeDir)) {
    console.error(`[988] knowledge dir not found at ${knowledgeDir}`)
    process.exit(1)
  }
  console.log(`[988] DB:            ${dbPath}`)
  console.log(`[988] knowledge dir: ${knowledgeDir}`)
  console.log(`[988] mode:          ${dryRun ? 'DRY-RUN (no writes)' : 'APPLY'}\n`)

  const db = new Database(dbPath)
  db.pragma('foreign_keys = ON')

  // The live DB may predate the TASK-988 schema changes (the MCP server applies
  // them via initSchema only on boot). Ensure the widened knowledge CHECK + the
  // code_refs / task_code_refs tables exist before mutating data. Idempotent and
  // identical to schema.ts so a later server boot is a no-op.
  ensureSchema(db)

  const rows = db
    .prepare(
      "SELECT slug, type FROM knowledge_index WHERE project_id = 'pim' ORDER BY slug"
    )
    .all()

  const plan = []
  for (const row of rows) {
    const md = readMd(row.slug)
    if (!md) {
      console.warn(`[988] WARN no .md for ${row.slug} — skipping`)
      continue
    }
    const kind = detectKind(md.raw)
    const newType = kind ? KIND_TO_TYPE[kind] : null
    if (!newType) {
      plan.push({ slug: row.slug, action: 'skip', reason: `kind=${kind ?? 'none'}` })
      continue
    }
    let structured
    let codeRef = null
    let touches = []
    if (newType === 'feature') {
      structured = parseFeature(md.raw)
    } else if (newType === 'gotcha') {
      const fid = markerField(md.raw, 'affected_feature_id')
      structured = fid ? { affectedFeatureId: fid } : undefined
    } else if (newType === 'code_ref') {
      codeRef = {
        slug: row.slug,
        projectId: 'pim',
        workspaceId: field(md.raw, 'Workspace'),
        path: field(md.raw, 'Path'),
        symbol: parseSymbol(md.raw),
        lineHint: parseLineHint(md.raw)
      }
      touches = parseTouches(md.raw)
    }
    plan.push({ slug: row.slug, action: 'retype', from: row.type, to: newType, structured, codeRef, touches, md })
  }

  for (const p of plan) {
    if (p.action === 'skip') {
      console.log(`  SKIP   ${p.slug} — ${p.reason}`)
      continue
    }
    console.log(`  RETYPE ${p.slug}: ${p.from} → ${p.to}`)
    if (p.codeRef) {
      console.log(`         path=${p.codeRef.path} symbol=${p.codeRef.symbol ?? 'NULL'} ws=${p.codeRef.workspaceId ?? 'NULL'} line=${p.codeRef.lineHint ?? '-'}`)
      for (const t of p.touches) console.log(`           TOUCHES ${t.taskId} (${t.relation})`)
    }
    if (p.structured) console.log(`         structured: ${JSON.stringify(p.structured)}`)
  }

  if (dryRun) {
    console.log('\n[988] dry-run complete — no changes written.')
    reportTask914(db)
    db.close()
    return
  }

  const apply = db.transaction(() => {
    const upsertCodeRef = db.prepare(
      `INSERT INTO code_refs (slug, project_id, workspace_id, path, symbol, line_hint, commit_sha, created_at, last_verified_at)
       VALUES (@slug, @projectId, @workspaceId, @path, @symbol, @lineHint, NULL, @now, @now)
       ON CONFLICT(slug) DO UPDATE SET
         workspace_id = excluded.workspace_id, path = excluded.path,
         symbol = excluded.symbol, line_hint = excluded.line_hint,
         last_verified_at = excluded.last_verified_at`
    )
    const addTouch = db.prepare(
      `INSERT INTO task_code_refs (task_id, code_ref_slug, relation) VALUES (?, ?, ?)
       ON CONFLICT(task_id, code_ref_slug) DO UPDATE SET relation = excluded.relation`
    )
    const retype = db.prepare('UPDATE knowledge_index SET type = ? WHERE slug = ?')

    for (const p of plan) {
      if (p.action !== 'retype') continue
      retype.run(p.to, p.slug)
      if (p.codeRef) {
        upsertCodeRef.run({ ...p.codeRef, now: NOW })
        for (const t of p.touches) addTouch.run(t.taskId, p.slug, t.relation)
      }
      const rewritten = rewriteFrontmatter(stripKindBlock(p.md.raw), p.to, p.structured)
      fs.writeFileSync(p.md.file, rewritten, 'utf8')
    }
  })
  apply()

  console.log('\n[988] migration applied.')
  reportTask914(db)
  db.close()
}

// AC check — TASK-914 TOUCHES breakdown. Pilot Dev Q6 (PILOT-B4-REPLAY.md
// L65-77): 2 modifies + 1 reference. (The task AC text said "0 reference",
// which contradicts the cited pilot evidence — pilot data is authoritative.)
function reportTask914(db) {
  let edges
  try {
    edges = db.prepare("SELECT code_ref_slug, relation FROM task_code_refs WHERE task_id = 'TASK-914' ORDER BY relation, code_ref_slug").all()
  } catch {
    console.log('[988] task_code_refs not present yet.')
    return
  }
  const modifies = edges.filter((e) => e.relation === 'modifies').length
  const reference = edges.filter((e) => e.relation === 'reference').length
  console.log(`\n[988] TASK-914 TOUCHES: ${modifies} modifies, ${reference} reference`)
  for (const e of edges) console.log(`        ${e.relation.padEnd(9)} ${e.code_ref_slug}`)
}

main()
