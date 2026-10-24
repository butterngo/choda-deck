import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import {
  formatHookOutput,
  parseFrontmatterRefPaths,
  parseToolPayload,
  resolveWorkspaceForCwd,
  resolveWorkspaceIdForCwd,
  runHook
} from '../file-edit-event.mjs'

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

  it('maps a cwd inside the <ws>.worktrees/<name> sibling to the workspace (autopilot run)', () => {
    const { dbPath, tmp } = makeTempDb()
    const db = new Database(dbPath)
    const inWorktree = path.join(`${FAKE_CWD}.worktrees`, 'autopilot-TASK-1', 'src')
    expect(resolveWorkspaceIdForCwd(db, inWorktree)).toBe('ws-test')
    // The .worktrees folder itself is not a checkout.
    expect(resolveWorkspaceIdForCwd(db, `${FAKE_CWD}.worktrees`)).toBeNull()
    db.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('a sibling repo sharing the prefix resolves to its own workspace, not to the shorter one', () => {
    const { dbPath, tmp } = makeTempDb()
    const db = new Database(dbPath)
    const deck = isWindows ? 'C:\\dev\\choda-deck' : '/dev/choda-deck'
    const companion = `${deck}-companion`
    db.prepare("INSERT INTO workspaces (id, project_id, label, cwd, archived_at) VALUES ('main', 'p', 'Main', ?, NULL)").run(deck)
    db.prepare(
      "INSERT INTO workspaces (id, project_id, label, cwd, archived_at) VALUES ('choda-deck-companion', 'p', 'Companion', ?, NULL)"
    ).run(companion)
    expect(resolveWorkspaceIdForCwd(db, companion)).toBe('choda-deck-companion')
    expect(resolveWorkspaceIdForCwd(db, path.join(`${companion}.worktrees`, 'x'))).toBe('choda-deck-companion')
    expect(resolveWorkspaceIdForCwd(db, path.join(`${deck}.worktrees`, 'x'))).toBe('main')
    db.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('resolveWorkspaceForCwd returns the worktree as the checkout root', () => {
    const { dbPath, tmp } = makeTempDb()
    const db = new Database(dbPath)
    const root = path.join(`${FAKE_CWD}.worktrees`, 'autopilot-TASK-1')
    expect(resolveWorkspaceForCwd(db, path.join(root, 'src'))).toEqual({ id: 'ws-test', cwd: FAKE_CWD, root })
    expect(resolveWorkspaceForCwd(db, FAKE_CWD)).toEqual({ id: 'ws-test', cwd: FAKE_CWD, root: FAKE_CWD })
    db.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })
})

describe('parseFrontmatterRefPaths', () => {
  it('reads every refs[].path and stops at the next top-level key', () => {
    const text =
      '---\r\ntype: gotcha\r\nrefs:\r\n  - path: src/a.ts\r\n    commitSha: abc\r\n  - path: "src/b.ts"\r\ncreatedAt: 2026-10-24\r\npath: not-a-ref.ts\r\n---\r\nbody'
    expect(parseFrontmatterRefPaths(text)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('returns [] for refs: [] and for a file with no frontmatter', () => {
    expect(parseFrontmatterRefPaths('---\ntype: gotcha\nrefs: []\n---\n')).toEqual([])
    expect(parseFrontmatterRefPaths('no frontmatter here')).toEqual([])
  })
})

describe('gotcha surfacing (TASK-2722)', () => {
  const hookPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'file-edit-event.mjs')
  const GOTCHA = 'g-src-a'
  const GOTCHA_TITLE = 'Editing src/a.ts breaks the widget'
  let tmp: string
  let dbPath: string
  let ws: string

  function writeGotcha(workspaceDir: string, slug: string, title: string, refPath: string): string {
    const file = path.join(workspaceDir, 'docs', 'knowledge', `${slug}.md`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `---\ntype: gotcha\ntitle: ${title}\nrefs:\n  - path: ${refPath}\n    commitSha: abc\n---\nbody\n`)
    const db = new Database(dbPath)
    db.prepare("INSERT INTO knowledge_index (slug, type, title, file_path) VALUES (?, 'gotcha', ?, ?)").run(slug, title, file)
    db.close()
    return file
  }

  function edit(cwd: string, filePath: string): string {
    return JSON.stringify({ cwd, tool_name: 'Edit', tool_input: { file_path: filePath, old_string: 'a', new_string: 'b' } })
  }

  function observations(): Array<Record<string, unknown>> {
    return readEvents(dbPath).map((e) => JSON.parse(e.payload_json))
  }

  function runAsProcess(stdin: string): { stdout: string; status: number | null } {
    const r = spawnSync(process.execPath, [hookPath], {
      input: stdin,
      env: { ...process.env, CHODA_DB_PATH: dbPath, CHODA_DATA_DIR: '' },
      encoding: 'utf8'
    })
    return { stdout: r.stdout, status: r.status }
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gotcha-surface-test-'))
    dbPath = path.join(tmp, 'choda-deck.db')
    ws = path.join(tmp, 'ws')
    fs.mkdirSync(ws)
    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, project_id TEXT, label TEXT, cwd TEXT NOT NULL, archived_at TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT, workspace_id TEXT, task_id TEXT, status TEXT NOT NULL, started_at TEXT NOT NULL);
      CREATE TABLE session_events (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, event_type TEXT NOT NULL, payload_json TEXT, memory_candidate INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      CREATE TABLE knowledge_index (slug TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, file_path TEXT NOT NULL);
    `)
    db.prepare("INSERT INTO workspaces (id, project_id, label, cwd, archived_at) VALUES ('ws', 'p', 'WS', ?, NULL)").run(ws)
    db.prepare(
      "INSERT INTO sessions (id, project_id, workspace_id, task_id, status, started_at) VALUES ('S1', 'p', 'ws', NULL, 'active', ?)"
    ).run(new Date().toISOString())
    db.close()
    writeGotcha(ws, GOTCHA, GOTCHA_TITLE, 'src/a.ts')
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('an Edit of a guarded file surfaces the gotcha and prints one additionalContext line', () => {
    const { stdout, status } = runAsProcess(edit(ws, path.join(ws, 'src', 'a.ts')))
    expect(status).toBe(0)
    const lines = stdout.split('\n').filter((l) => l.trim() !== '')
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0])
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PostToolUse')
    expect(parsed.hookSpecificOutput.additionalContext).toContain(GOTCHA)
    expect(parsed.hookSpecificOutput.additionalContext).toContain(GOTCHA_TITLE)
  })

  it('runHook returns surfaced: [G] for a guarded Edit, with a relative file_path too', () => {
    const result = runHook({ stdinJson: edit(ws, 'src/a.ts'), dbPathOverride: dbPath })
    expect(result.surfaced).toEqual([GOTCHA])
    expect(formatHookOutput(result)).not.toBeNull()
  })

  it('the same Edit from the <ws>.worktrees/x autopilot checkout surfaces G', () => {
    const wt = path.join(`${ws}.worktrees`, 'x')
    fs.mkdirSync(path.join(wt, 'src'), { recursive: true })
    const result = runHook({ stdinJson: edit(wt, path.join(wt, 'src', 'a.ts')), dbPathOverride: dbPath })
    expect(result.ok).toBe(true)
    expect(result.surfaced).toEqual([GOTCHA])
    fs.rmSync(`${ws}.worktrees`, { recursive: true, force: true })
  })

  it('a second Edit of the same file in the session surfaces nothing and prints nothing', () => {
    const first = runAsProcess(edit(ws, path.join(ws, 'src', 'a.ts')))
    expect(first.stdout.trim()).not.toBe('')
    const second = runAsProcess(edit(ws, path.join(ws, 'src', 'a.ts')))
    expect(second.status).toBe(0)
    expect(second.stdout).toBe('')
    const again = runHook({ stdinJson: edit(ws, path.join(ws, 'src', 'a.ts')), dbPathOverride: dbPath })
    expect(again.surfaced).toEqual([])
  })

  it('an Edit of a file no gotcha names surfaces nothing, prints nothing, still writes file_modified', () => {
    const { stdout, status } = runAsProcess(edit(ws, path.join(ws, 'src', 'other.ts')))
    expect(status).toBe(0)
    expect(stdout).toBe('')
    const result = runHook({ stdinJson: edit(ws, path.join(ws, 'src', 'other.ts')), dbPathOverride: dbPath })
    expect(result.surfaced).toEqual([])
    expect(observations().filter((o) => o.kind === 'file_modified')).toHaveLength(2)
    expect(observations().filter((o) => o.kind === 'gotcha_surfaced')).toHaveLength(0)
  })

  it('each surfacing records exactly one gotcha_surfaced observation with slug and relative path', () => {
    runHook({ stdinJson: edit(ws, path.join(ws, 'src', 'a.ts')), dbPathOverride: dbPath })
    runHook({ stdinJson: edit(ws, path.join(ws, 'src', 'a.ts')), dbPathOverride: dbPath })
    const surfaced = observations().filter((o) => o.kind === 'gotcha_surfaced')
    expect(surfaced).toEqual([{ kind: 'gotcha_surfaced', slug: GOTCHA, path: 'src/a.ts' }])
  })

  it("another workspace's gotcha naming the same relative path is not surfaced", () => {
    const other = path.join(tmp, 'ws-other')
    writeGotcha(other, 'g-other', 'Other repo gotcha', 'src/a.ts')
    const result = runHook({ stdinJson: edit(ws, path.join(ws, 'src', 'a.ts')), dbPathOverride: dbPath })
    expect(result.surfaced).toEqual([GOTCHA])
  })

  it('a gotcha whose markdown file is gone is skipped without throwing', () => {
    fs.rmSync(path.join(ws, 'docs', 'knowledge', `${GOTCHA}.md`))
    const result = runHook({ stdinJson: edit(ws, path.join(ws, 'src', 'a.ts')), dbPathOverride: dbPath })
    expect(result.ok).toBe(true)
    expect(result.surfaced).toEqual([])
    expect(observations().filter((o) => o.kind === 'file_modified')).toHaveLength(1)
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

  it('a DB without knowledge_index still writes file_modified and surfaces nothing', () => {
    seedActiveSession(dbPath)
    const result = runHook({
      stdinJson: JSON.stringify({
        cwd: FAKE_CWD,
        tool_name: 'Edit',
        tool_input: { file_path: 'src/foo.ts', old_string: 'a', new_string: 'b' }
      }),
      dbPathOverride: dbPath
    })
    expect(result.ok).toBe(true)
    expect(result.surfaced).toEqual([])
    expect(readEvents(dbPath)).toHaveLength(1)
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
