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
 * ## Gotcha surfacing (TASK-2722)
 *
 * When the edited file is named in the frontmatter `refs[].path` of a gotcha
 * filed under the workspace's `docs/knowledge/`, stdout carries ONE line
 * `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":…}}`
 * naming it, and a `kind='gotcha_surfaced'` observation is recorded — once per
 * gotcha per session. A cwd inside `<workspaceCwd>.worktrees/<name>` (an
 * autopilot run) resolves to that workspace.
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
// TASK-2722 — a run worktree lives BESIDE its workspace, at
// `<workspaceCwd>.worktrees/<name>` (src/core/worktree-path.ts), so plain
// descendant matching never sees an autopilot run. Returns the worktree root
// when `normCwd` is inside one of `normWs`'s worktrees, else null.
function worktreeRootFor(normWs, normCwd) {
  const base = `${normWs}.worktrees`
  if (!isDescendantOrEqual(base, normCwd) || normCwd === base) return null
  const first = path.relative(base, normCwd).split(/[\\/]/)[0]
  return path.join(base, first)
}

/**
 * Resolve the workspace a cwd belongs to. `root` is the checkout the cwd sits
 * in — the workspace cwd itself, or the `.worktrees/<name>` sibling — in the
 * caller's original casing, so repo-relative paths come out readable.
 * Longest root wins, so `C:\dev\x-companion` never resolves to `C:\dev\x`.
 */
export function resolveWorkspaceForCwd(db, cwd) {
  if (!cwd) return null
  const rows = db
    .prepare("SELECT id, cwd FROM workspaces WHERE archived_at IS NULL")
    .all()
  const resolvedCwd = path.resolve(cwd)
  const normCwd = normalizePath(cwd)
  const matches = []
  for (const w of rows) {
    const normWs = normalizePath(w.cwd)
    if (isDescendantOrEqual(normWs, normCwd)) {
      matches.push({ id: w.id, cwd: w.cwd, root: w.cwd, rootLen: normWs.length })
      continue
    }
    const wt = worktreeRootFor(normWs, normCwd)
    if (wt) {
      matches.push({ id: w.id, cwd: w.cwd, root: resolvedCwd.slice(0, wt.length), rootLen: wt.length })
    }
  }
  matches.sort((a, b) => b.rootLen - a.rootLen)
  if (matches.length === 0) return null
  const { id, cwd: workspaceCwd, root } = matches[0]
  return { id, cwd: workspaceCwd, root }
}

export function resolveWorkspaceIdForCwd(db, cwd) {
  return resolveWorkspaceForCwd(db, cwd)?.id ?? null
}

// ── gotcha surfacing (TASK-2722) ──────────────────────────────────────────────
// A gotcha "guards" every file its frontmatter `refs[].path` names. When one of
// those files is edited, the hook hands the gotcha to the agent once per session
// via PostToolUse `additionalContext`, and records a `gotcha_surfaced`
// observation so the surfacing can be evaluated later.

const toRelKey = (p) => {
  const posix = p.replace(/\\/g, '/').replace(/^\.\//, '')
  return isWindows ? posix.toLowerCase() : posix
}

/** `refs[].path` values from a knowledge file's frontmatter, [] when none. */
export function parseFrontmatterRefPaths(text) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!fm) return []
  const lines = fm[1].split(/\r?\n/)
  const start = lines.findIndex((l) => /^refs:\s*$/.test(l))
  if (start < 0) return []
  const out = []
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break // next top-level key ends the block
    const m = /^\s*-?\s*path:\s*["']?([^"'\r\n]+?)["']?\s*$/.exec(line)
    if (m) out.push(m[1])
  }
  return out
}

/**
 * Gotchas filed under the workspace's `docs/knowledge/` whose refs name
 * `relPath` and that this session has not surfaced yet. A gotcha whose file is
 * missing or unreadable is skipped.
 */
export function findGotchasToSurface(db, { sessionId, workspaceCwd, relPath }) {
  const knowledgeDir = normalizePath(path.join(workspaceCwd, 'docs', 'knowledge'))
  const already = new Set()
  const prior = db
    .prepare(
      "SELECT payload_json FROM session_events WHERE session_id = ? AND event_type = 'observation' AND payload_json LIKE '%gotcha_surfaced%'"
    )
    .all(sessionId)
  for (const row of prior) {
    try {
      const p = JSON.parse(row.payload_json)
      if (p?.kind === 'gotcha_surfaced' && typeof p.slug === 'string') already.add(p.slug)
    } catch {
      /* malformed payload — ignore */
    }
  }

  const key = toRelKey(relPath)
  const gotchas = db
    .prepare("SELECT slug, title, file_path FROM knowledge_index WHERE type = 'gotcha' ORDER BY slug")
    .all()
  const hits = []
  for (const g of gotchas) {
    if (already.has(g.slug)) continue
    if (!isDescendantOrEqual(knowledgeDir, normalizePath(g.file_path))) continue
    let text
    try {
      text = fs.readFileSync(g.file_path, 'utf8')
    } catch {
      continue
    }
    if (parseFrontmatterRefPaths(text).some((r) => toRelKey(r) === key)) {
      hits.push({ slug: g.slug, title: g.title })
    }
  }
  return hits
}

/** The single stdout line Claude Code reads, or null when nothing surfaced. */
export function formatHookOutput(result) {
  if (!result?.additionalContext) return null
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: result.additionalContext }
  })
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

    const effectiveCwd = cwd ?? process.cwd()
    const workspace = resolveWorkspaceForCwd(db, effectiveCwd)
    if (!workspace) return { skipped: 'no-workspace-match' }
    const workspaceId = workspace.id

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

    // Surfacing must never cost the file_modified event above or the host
    // Edit: any failure here (no knowledge_index, unreadable file) surfaces nothing.
    const surfaced = []
    const lines = []
    try {
      for (const mod of modifications) {
        const abs = path.resolve(effectiveCwd, mod.path)
        const relPath = path.relative(workspace.root, abs).replace(/\\/g, '/')
        if (relPath.startsWith('..') || path.isAbsolute(relPath)) continue
        const hits = findGotchasToSurface(db, { sessionId: session.id, workspaceCwd: workspace.cwd, relPath })
        if (hits.length === 0) continue
        lines.push(`Gotchas guarding ${relPath} — read before continuing:`)
        for (const g of hits) {
          insert.run(
            generateEventId(),
            session.id,
            JSON.stringify({ kind: 'gotcha_surfaced', slug: g.slug, path: relPath }),
            ts
          )
          surfaced.push(g.slug)
          lines.push(`- ${g.title} (knowledge_get "${g.slug}")`)
        }
      }
    } catch (err) {
      process.stderr.write(`[file-edit-event] gotcha lookup skipped: ${err.message ?? err}\n`)
    }

    return {
      ok: true,
      sessionId: session.id,
      workspaceId,
      eventIds,
      surfaced,
      ...(lines.length > 0 ? { additionalContext: lines.join('\n') } : {})
    }
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
    CREATE TABLE knowledge_index (
      slug TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      file_path TEXT NOT NULL
    );
  `)
  // A real on-disk workspace whose gotcha guards src/guarded.ts.
  const guardedWs = path.join(tmp, 'guarded-ws')
  const gotchaFile = path.join(guardedWs, 'docs', 'knowledge', 'selftest-gotcha.md')
  fs.mkdirSync(path.dirname(gotchaFile), { recursive: true })
  fs.writeFileSync(
    gotchaFile,
    '---\ntype: gotcha\ntitle: Self-test gotcha\nrefs:\n  - path: src/guarded.ts\n    commitSha: abc\n---\nbody\n'
  )
  db.prepare(
    "INSERT INTO workspaces (id, project_id, label, cwd, archived_at) VALUES ('ws-guarded', 'proj', 'Guarded', ?, NULL)"
  ).run(guardedWs)
  db.prepare(
    "INSERT INTO sessions (id, project_id, workspace_id, task_id, status, started_at) VALUES ('SESSION-guarded', 'proj', 'ws-guarded', NULL, 'active', ?)"
  ).run(new Date().toISOString())
  db.prepare(
    "INSERT INTO knowledge_index (slug, type, title, file_path) VALUES ('selftest-gotcha', 'gotcha', 'Self-test gotcha', ?)"
  ).run(gotchaFile)
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
    if (r.surfaced.length !== 0) {
      console.error(`[self-test] ${c.label}: expected nothing surfaced, got`, r.surfaced)
      process.exit(1)
    }
  }
  const guardedEdit = JSON.stringify({
    cwd: guardedWs,
    tool_name: 'Edit',
    tool_input: { file_path: path.join(guardedWs, 'src', 'guarded.ts'), old_string: 'a', new_string: 'b' }
  })
  const first = runHook({ stdinJson: guardedEdit, dbPathOverride: dbPath })
  const out = formatHookOutput(first)
  if (
    first.surfaced?.join() !== 'selftest-gotcha' ||
    !out ||
    !JSON.parse(out).hookSpecificOutput.additionalContext.includes('selftest-gotcha')
  ) {
    console.error('[self-test] guarded Edit: expected selftest-gotcha surfaced, got', first)
    process.exit(1)
  }
  const second = runHook({ stdinJson: guardedEdit, dbPathOverride: dbPath })
  if (second.surfaced?.length !== 0 || formatHookOutput(second) !== null) {
    console.error('[self-test] repeat guarded Edit: expected nothing surfaced, got', second)
    process.exit(1)
  }
  // Verify rows
  const verify = new Database(dbPath)
  const rows = verify
    .prepare("SELECT event_type, payload_json FROM session_events ORDER BY id ASC")
    .all()
  verify.close()
  fs.rmSync(tmp, { recursive: true, force: true })
  const kinds = rows.map((row) => (row.event_type === 'observation' ? JSON.parse(row.payload_json).kind : row.event_type))
  const fileModified = kinds.filter((k) => k === 'file_modified').length
  const surfacedRows = kinds.filter((k) => k === 'gotcha_surfaced').length
  if (fileModified !== 5 || surfacedRows !== 1 || kinds.length !== 6) {
    console.error(`[self-test] expected 5 file_modified + 1 gotcha_surfaced, got ${JSON.stringify(kinds)}`)
    process.exit(1)
  }
  console.error('[self-test] OK — 5 file_modified events + 1 gotcha_surfaced (once per session)')
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
      const out = formatHookOutput(result)
      // Synchronous: process.exit below must not cut the line Claude Code reads.
      if (out) fs.writeSync(1, `${out}\n`)
      process.exit(0)
    }
  } catch (err) {
    process.stderr.write(`[file-edit-event] swallow error: ${err.message ?? err}\n`)
    process.exit(0)
  }
}
