import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import Database from 'better-sqlite3'
import { parseToolPayload, resolveWorkspaceIdForCwd, runHook } from '../file-edit-event.mjs'

const isWindows = process.platform === 'win32'
const FAKE_CWD = isWindows ? 'C:\\tmp\\hook-test-ws' : '/tmp/hook-test-ws'

function makeTempDb(): { dbPath: string; tmp: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'file-edit-event-test-'))
  const dbPath = path.join(tmp, 'choda-deck.db')
  const db = new Database(dbPath)
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
  db.prepare(
    "INSERT INTO workspaces (id, project_id, label, cwd, archived_at) VALUES ('ws-test', 'proj', 'Test', ?, NULL)"
  ).run(FAKE_CWD)
  db.close()
  return { dbPath, tmp }
}

function seedActiveSession(dbPath: string): string {
  const db = new Database(dbPath)
  const id = 'SESSION-hook-test'
  db.prepare(
    "INSERT INTO sessions (id, project_id, workspace_id, task_id, status, started_at) VALUES (?, 'proj', 'ws-test', NULL, 'active', ?)"
  ).run(id, new Date().toISOString())
  db.close()
  return id
}

function readEvents(dbPath: string): Array<{ event_type: string; payload_json: string }> {
  const db = new Database(dbPath)
  const rows = db
    .prepare("SELECT event_type, payload_json FROM session_events ORDER BY id ASC")
    .all() as Array<{ event_type: string; payload_json: string }>
  db.close()
  return rows
}

describe('parseToolPayload', () => {
  it('extracts Edit shape — counts old and new lines', () => {
    const out = parseToolPayload('Edit', {
      file_path: 'src/foo.ts',
      old_string: 'a\nb',
      new_string: 'a\nb\nc'
    })
    expect(out).toEqual([
      { path: 'src/foo.ts', linesAdded: 3, linesRemoved: 2, tool: 'Edit' }
    ])
  })

  it('extracts Write shape — linesAdded = lines in content, linesRemoved = 0', () => {
    const out = parseToolPayload('Write', { file_path: 'src/bar.ts', content: 'one\ntwo\nthree' })
    expect(out).toEqual([
      { path: 'src/bar.ts', linesAdded: 3, linesRemoved: 0, tool: 'Write' }
    ])
  })

  it('extracts MultiEdit shape — aggregates per-file edit counts into a single event', () => {
    const out = parseToolPayload('MultiEdit', {
      file_path: 'src/baz.ts',
      edits: [
        { old_string: 'A', new_string: 'A1\nA2' },
        { old_string: 'B\nB', new_string: 'B1' }
      ]
    })
    expect(out).toHaveLength(1)
    expect(out[0].path).toBe('src/baz.ts')
    expect(out[0].linesAdded).toBe(3) // 2 + 1
    expect(out[0].linesRemoved).toBe(3) // 1 + 2
    expect(out[0].tool).toBe('MultiEdit')
  })

  it('returns [] for unknown tool', () => {
    expect(parseToolPayload('Bash', { command: 'ls' })).toEqual([])
  })

  it('returns [] when file_path missing', () => {
    expect(parseToolPayload('Edit', { old_string: 'x', new_string: 'y' })).toEqual([])
  })

  it('returns [] when MultiEdit.edits is not an array', () => {
    expect(parseToolPayload('MultiEdit', { file_path: 'x', edits: 'not array' })).toEqual([])
  })
})

describe('resolveWorkspaceIdForCwd', () => {
  it('matches exact workspace cwd', () => {
    const { dbPath, tmp } = makeTempDb()
    const db = new Database(dbPath)
    expect(resolveWorkspaceIdForCwd(db, FAKE_CWD)).toBe('ws-test')
    db.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('matches descendant cwd via prefix', () => {
    const { dbPath, tmp } = makeTempDb()
    const db = new Database(dbPath)
    const child = path.join(FAKE_CWD, 'src', 'deep', 'nested')
    expect(resolveWorkspaceIdForCwd(db, child)).toBe('ws-test')
    db.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('returns null when cwd has no workspace prefix match', () => {
    const { dbPath, tmp } = makeTempDb()
    const db = new Database(dbPath)
    const unrelated = isWindows ? 'C:\\unrelated\\path' : '/unrelated/path'
    expect(resolveWorkspaceIdForCwd(db, unrelated)).toBeNull()
    db.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })
})

describe('runHook integration', () => {
  let dbPath: string
  let tmp: string

  beforeEach(() => {
    ;({ dbPath, tmp } = makeTempDb())
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('writes one file_modified observation when session is active and cwd matches', () => {
    const sessionId = seedActiveSession(dbPath)
    const result = runHook({
      stdinJson: JSON.stringify({
        cwd: FAKE_CWD,
        tool_name: 'Edit',
        tool_input: { file_path: 'src/foo.ts', old_string: 'a', new_string: 'a\nb' }
      }),
      dbPathOverride: dbPath
    })
    expect(result.ok).toBe(true)
    expect(result.sessionId).toBe(sessionId)
    expect(result.eventIds).toHaveLength(1)

    const events = readEvents(dbPath)
    expect(events).toHaveLength(1)
    const payload = JSON.parse(events[0].payload_json)
    expect(payload.kind).toBe('file_modified')
    expect(payload.path).toBe('src/foo.ts')
    expect(payload.tool).toBe('Edit')
    expect(payload.linesAdded).toBe(2)
    expect(payload.linesRemoved).toBe(1)
  })

  it('no-op (silent) when no active session for the workspace', () => {
    // No session inserted.
    const result = runHook({
      stdinJson: JSON.stringify({
        cwd: FAKE_CWD,
        tool_name: 'Edit',
        tool_input: { file_path: 'x.ts', old_string: 'a', new_string: 'b' }
      }),
      dbPathOverride: dbPath
    })
    expect(result.ok).toBeUndefined()
    expect(result.skipped).toBe('no-active-session')
    expect(readEvents(dbPath)).toHaveLength(0)
  })

  it('no-op when cwd does not match any workspace', () => {
    seedActiveSession(dbPath)
    const result = runHook({
      stdinJson: JSON.stringify({
        cwd: isWindows ? 'C:\\nowhere' : '/nowhere',
        tool_name: 'Edit',
        tool_input: { file_path: 'x.ts', old_string: 'a', new_string: 'b' }
      }),
      dbPathOverride: dbPath
    })
    expect(result.skipped).toBe('no-workspace-match')
    expect(readEvents(dbPath)).toHaveLength(0)
  })

  it('no-op (does not throw) on malformed JSON stdin', () => {
    seedActiveSession(dbPath)
    const result = runHook({ stdinJson: 'not-json-at-all{', dbPathOverride: dbPath })
    // Falls through both stdin and env paths → no modifications parsed.
    expect(result.skipped).toBe('no-modifications-parsed')
    expect(readEvents(dbPath)).toHaveLength(0)
  })

  it('MultiEdit on the same file produces exactly one event with aggregated lines', () => {
    seedActiveSession(dbPath)
    const result = runHook({
      stdinJson: JSON.stringify({
        cwd: FAKE_CWD,
        tool_name: 'MultiEdit',
        tool_input: {
          file_path: 'src/baz.ts',
          edits: [
            { old_string: 'A', new_string: 'A1\nA2' },
            { old_string: 'B\nB', new_string: 'B1' }
          ]
        }
      }),
      dbPathOverride: dbPath
    })
    expect(result.ok).toBe(true)
    expect(result.eventIds).toHaveLength(1)
    const events = readEvents(dbPath)
    expect(events).toHaveLength(1)
    const payload = JSON.parse(events[0].payload_json)
    expect(payload.linesAdded).toBe(3)
    expect(payload.linesRemoved).toBe(3)
  })

  it('env-var fallback: reads CLAUDE_TOOL_INPUT when stdin is empty', () => {
    seedActiveSession(dbPath)
    const envInput = JSON.stringify({
      cwd: FAKE_CWD,
      tool_name: 'Write',
      tool_input: { file_path: 'src/env.ts', content: 'x\ny\nz' }
    })
    const result = runHook({ envToolInput: envInput, dbPathOverride: dbPath })
    expect(result.ok).toBe(true)
    const events = readEvents(dbPath)
    expect(events).toHaveLength(1)
    const payload = JSON.parse(events[0].payload_json)
    expect(payload.path).toBe('src/env.ts')
    expect(payload.tool).toBe('Write')
  })

  it('returns no-db skip when the DB file does not exist (still does not crash)', () => {
    const result = runHook({
      stdinJson: JSON.stringify({
        cwd: FAKE_CWD,
        tool_name: 'Edit',
        tool_input: { file_path: 'x.ts', old_string: 'a', new_string: 'b' }
      }),
      dbPathOverride: path.join(tmp, 'does-not-exist.db')
    })
    expect(result.skipped).toBe('no-db')
  })
})
