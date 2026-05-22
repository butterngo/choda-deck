/**
 * ADR-029 channel 1 — Claude Code `PostToolUse` hook that emits a
 * `kind='file_modified'` observation row on `session_events` for every
 * Edit / Write / MultiEdit operation in an active session's workspace.
 *
 * ## Install (per developer)
 *
 * Add to `~/.claude/settings.json`:
 *
 * ```jsonc
 * {
 *   "hooks": {
 *     "PostToolUse": [
 *       {
 *         "matcher": "Edit|Write|MultiEdit",
 *         "hooks": [
 *           {
 *             "type": "command",
 *             "command": "node C:\\dev\\choda-deck\\scripts\\hooks\\file-edit-event.mjs"
 *           }
 *         ]
 *       }
 *     ]
 *   }
 * }
 * ```
 *
 * The hook is **opt-in per developer**. Without it, channels 2 + 3 (ac_check,
 * session_end summary) still work — only the file-edit telemetry is missing.
 *
 * ## Input contract
 *
 * Claude Code pipes JSON to stdin with shape:
 *   { cwd, tool_name, tool_input: {...}, hook_event_name, session_id, ... }
 *
 * Fallback: if stdin is empty, reads `$CLAUDE_TOOL_INPUT` env var (legacy /
 * hand-test convention) and uses `process.cwd()` for workspace resolution.
 *
 * ## Safety contract
 *
 * - Never crashes the host Edit — all error paths write to stderr and exit 0.
 * - Silent no-op when no active session for the resolved workspace.
 * - Writes via better-sqlite3 directly (no MCP stdio subprocess).
 *
 * ## Self-test
 *
 *   node scripts/hooks/file-edit-event.mjs --self-test
 *
 * Builds a temp DB, fires synthetic Edit/Write/MultiEdit inputs, asserts the
 * observation rows landed with correct payload shapes. Exit 0 on success.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const isWindows = process.platform === 'win32'

// ── path resolution (mirrors src/core/paths.ts resolveDataPaths) ────────────
export function resolveDbPath() {
  const legacy = process.env.CHODA_DB_PATH
  const envDataDir = process.env.CHODA_DATA_DIR
  if (legacy) return path.resolve(legacy)
  const dataDir = envDataDir ? path.resolve(envDataDir) : path.join(process.cwd(), 'data')
  return path.join(dataDir, 'database', 'choda-deck.db')
}

// ── workspace prefix matching (mirrors workspace-resolver.ts) ────────────────
function normalizePath(p) {
  const r = path.resolve(p).replace(/[\\/]+$/, '')
  return isWindows ? r.toLowerCase().replace(/\//g, '\\') : r
}
function isDescendantOrEqual(parent, child) {
  if (parent === child) return true
  const rel = path.relative(parent, child)
  if (rel === '') return true
  if (rel.startsWith('..')) return false
  return !path.isAbsolute(rel)
}
export function resolveWorkspaceIdForCwd(db, cwd) {
  if (!cwd) return null
  const rows = db
    .prepare("SELECT id, cwd FROM workspaces WHERE archived_at IS NULL")
    .all()
  const normCwd = normalizePath(cwd)
  const matches = rows
    .map((w) => ({ id: w.id, norm: normalizePath(w.cwd) }))
    .filter((m) => isDescendantOrEqual(m.norm, normCwd))
    .sort((a, b) => b.norm.length - a.norm.length)
  return matches.length > 0 ? matches[0].id : null
}

// ── event-id generation ───────────────────────────────────────────────────────
let idCounter = 0
function generateEventId() {
  idCounter += 1
  return `EVT-${Date.now()}-${idCounter}`
}

// ── tool-payload parsing — returns [{path, linesAdded, linesRemoved, tool}] ──
function countLines(s) {
  if (!s) return 0
  // Match every line including trailing-newline-terminated last line.
  return s.split(/\r?\n/).length
}

export function parseToolPayload(toolName, toolInput) {
  if (!toolName || !toolInput || typeof toolInput !== 'object') return []
  const tn = String(toolName)

  if (tn === 'Edit') {
    const p = toolInput.file_path
    if (!p) return []
    const oldS = String(toolInput.old_string ?? '')
    const newS = String(toolInput.new_string ?? '')
    return [
      {
        path: String(p),
        linesAdded: countLines(newS),
        linesRemoved: countLines(oldS),
        tool: 'Edit'
      }
    ]
  }

  if (tn === 'Write') {
    const p = toolInput.file_path
    if (!p) return []
    const content = String(toolInput.content ?? '')
    return [
      {
        path: String(p),
        linesAdded: countLines(content),
        linesRemoved: 0,
        tool: 'Write'
      }
    ]
  }

  if (tn === 'MultiEdit') {
    const p = toolInput.file_path
    if (!p || !Array.isArray(toolInput.edits)) return []
    // Aggregate all edits on the same file into one event.
    let added = 0
    let removed = 0
    for (const e of toolInput.edits) {
      added += countLines(String(e?.new_string ?? ''))
      removed += countLines(String(e?.old_string ?? ''))
    }
    return [
      {
        path: String(p),
        linesAdded: added,
        linesRemoved: removed,
        tool: 'MultiEdit'
      }
    ]
  }

  return []
}

// ── stdin reading (sync) ──────────────────────────────────────────────────────
function readStdinSync() {
  try {
    if (process.stdin.isTTY) return ''
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

// ── main flow ─────────────────────────────────────────────────────────────────
export function runHook({ stdinJson, envToolInput, cwdOverride, dbPathOverride } = {}) {
  // Build the effective input. Prefer stdin (real CC contract), then env, then nothing.
  let payload = null
  if (stdinJson && stdinJson.trim().length > 0) {
    try {
      payload = JSON.parse(stdinJson)
    } catch {
      payload = null
    }
  }
  let toolName
  let toolInput
  let cwd
  if (payload && typeof payload === 'object') {
    toolName = payload.tool_name
    toolInput = payload.tool_input
    cwd = payload.cwd
  } else if (envToolInput) {
    try {
      const env = JSON.parse(envToolInput)
      toolName = env.tool_name
      toolInput = env.tool_input ?? env
      cwd = env.cwd
    } catch {
      return { skipped: 'malformed-env-input' }
    }
  }
  if (cwdOverride) cwd = cwdOverride

  const modifications = parseToolPayload(toolName, toolInput)
  if (modifications.length === 0) return { skipped: 'no-modifications-parsed' }

  const dbPath = dbPathOverride ?? resolveDbPath()
  if (!fs.existsSync(dbPath)) {
    // No DB → choda-deck not initialized on this machine; silent no-op.
    return { skipped: 'no-db' }
  }

  const db = new Database(dbPath)
  try {
    db.pragma('foreign_keys = ON')

    const workspaceId = resolveWorkspaceIdForCwd(db, cwd ?? process.cwd())
    if (!workspaceId) return { skipped: 'no-workspace-match' }

    const session = db
      .prepare(
        "SELECT id FROM sessions WHERE workspace_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1"
      )
      .get(workspaceId)
    if (!session) return { skipped: 'no-active-session', workspaceId }

    const insert = db.prepare(
      "INSERT INTO session_events (id, session_id, event_type, payload_json, memory_candidate, created_at) VALUES (?, ?, 'observation', ?, 0, ?)"
    )
    const eventIds = []
    const ts = new Date().toISOString()
    for (const mod of modifications) {
      const id = generateEventId()
      const payloadJson = JSON.stringify({
        kind: 'file_modified',
        path: mod.path,
        linesAdded: mod.linesAdded,
        linesRemoved: mod.linesRemoved,
        tool: mod.tool
      })
      insert.run(id, session.id, payloadJson, ts)
      eventIds.push(id)
    }
    return { ok: true, sessionId: session.id, workspaceId, eventIds }
  } finally {
    db.close()
  }
}

// ── self-test (--self-test) ───────────────────────────────────────────────────
function runSelfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'file-edit-event-selftest-'))
  const dbPath = path.join(tmp, 'choda-deck.db')
  const db = new Database(dbPath)
  // Minimal schema — only the tables this hook touches. Use TEXT for everything
  // so the self-test doesn't drift if the real schema evolves; the hook
  // doesn't read these rows, only inserts.
  db.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      label TEXT,
      cwd TEXT NOT NULL,
      archived_at TEXT
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      workspace_id TEXT,
      task_id TEXT,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL
    );
    CREATE TABLE session_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT,
      memory_candidate INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `)
  const fakeCwd = isWindows ? 'C:\\tmp\\selftest-ws' : '/tmp/selftest-ws'
  db.prepare(
    "INSERT INTO workspaces (id, project_id, label, cwd, archived_at) VALUES ('ws-selftest', 'proj', 'Self Test', ?, NULL)"
  ).run(fakeCwd)
  db.prepare(
    "INSERT INTO sessions (id, project_id, workspace_id, task_id, status, started_at) VALUES ('SESSION-selftest', 'proj', 'ws-selftest', NULL, 'active', ?)"
  ).run(new Date().toISOString())
  db.close()

  const cases = [
    {
      label: 'Edit',
      stdin: JSON.stringify({
        cwd: fakeCwd,
        tool_name: 'Edit',
        tool_input: { file_path: 'src/foo.ts', old_string: 'a\nb\n', new_string: 'a\nb\nc\n' }
      })
    },
    {
      label: 'Write',
      stdin: JSON.stringify({
        cwd: fakeCwd,
        tool_name: 'Write',
        tool_input: { file_path: 'src/bar.ts', content: 'one\ntwo\nthree' }
      })
    },
    {
      label: 'MultiEdit',
      stdin: JSON.stringify({
        cwd: fakeCwd,
        tool_name: 'MultiEdit',
        tool_input: {
          file_path: 'src/baz.ts',
          edits: [
            { old_string: 'A', new_string: 'A1\nA2' },
            { old_string: 'B\nB', new_string: 'B1' }
          ]
        }
      })
    }
  ]
  for (const c of cases) {
    const r = runHook({ stdinJson: c.stdin, dbPathOverride: dbPath })
    if (!r.ok) {
      console.error(`[self-test] ${c.label}: expected ok=true, got`, r)
      process.exit(1)
    }
  }
  // Verify rows
  const verify = new Database(dbPath)
  const rows = verify
    .prepare("SELECT event_type, payload_json FROM session_events ORDER BY id ASC")
    .all()
  verify.close()
  fs.rmSync(tmp, { recursive: true, force: true })
  if (rows.length !== 3) {
    console.error(`[self-test] expected 3 events, got ${rows.length}`)
    process.exit(1)
  }
  for (const row of rows) {
    if (row.event_type !== 'observation') {
      console.error(`[self-test] expected observation, got ${row.event_type}`)
      process.exit(1)
    }
    const payload = JSON.parse(row.payload_json)
    if (payload.kind !== 'file_modified') {
      console.error(`[self-test] expected kind=file_modified, got ${payload.kind}`)
      process.exit(1)
    }
  }
  console.error('[self-test] OK — 3 file_modified events landed (Edit, Write, MultiEdit)')
  process.exit(0)
}

// ── entry point ───────────────────────────────────────────────────────────────
function isDirectExec() {
  const thisFile = fileURLToPath(import.meta.url)
  const argv1 = process.argv[1] ? path.resolve(process.argv[1]) : ''
  return thisFile === argv1
}

if (isDirectExec()) {
  try {
    if (process.argv.includes('--self-test')) {
      runSelfTest()
    } else {
      const stdinJson = readStdinSync()
      const envToolInput = process.env.CLAUDE_TOOL_INPUT
      const result = runHook({ stdinJson, envToolInput })
      // Silent on no-op; only log explicit success for debugability via stderr.
      if (result.ok) {
        process.stderr.write(
          `[file-edit-event] wrote ${result.eventIds.length} file_modified event(s) for session ${result.sessionId}\n`
        )
      }
      process.exit(0)
    }
  } catch (err) {
    process.stderr.write(`[file-edit-event] swallow error: ${err.message ?? err}\n`)
    process.exit(0)
  }
}
