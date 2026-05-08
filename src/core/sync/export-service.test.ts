import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { createHash } from 'crypto'
import Database from 'better-sqlite3'

import { runExport } from './export-service'
import { initSchema } from '../domain/repositories/schema'
import type { GitCommands } from './workspace-identity'
import type { SnapshotManifest } from './snapshot-types'

let tmp: string
let db: Database.Database

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'choda-export-'))
  db = new Database(':memory:')
  initSchema(db)
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const FROZEN_NOW = '2026-05-08T00:00:00.000Z'

function localGit(): GitCommands {
  return { gitCommonDir: () => null, showToplevel: () => null, getRemoteOrigin: () => null }
}

function gitWithRemote(remote: string, repoRoot: string): GitCommands {
  return {
    gitCommonDir: () => path.join(repoRoot, '.git'),
    showToplevel: () => repoRoot,
    getRemoteOrigin: () => remote
  }
}

function seedProject(id: string, cwd: string): void {
  db.prepare('INSERT INTO projects (id, name, cwd) VALUES (?, ?, ?)').run(id, id, cwd)
  db.prepare('INSERT INTO workspaces (id, project_id, label, cwd) VALUES (?, ?, ?, ?)').run(
    `${id}-main`,
    id,
    'main',
    cwd
  )
}

function seedTask(id: string, projectId: string, title: string): void {
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, status, created_at, updated_at)
     VALUES (?, ?, ?, 'TODO', '2026-05-08T00:00:00.000Z', '2026-05-08T00:00:00.000Z')`
  ).run(id, projectId, title)
}

function readManifest(outDir: string): SnapshotManifest {
  return JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'))
}

function fileHash(p: string): string {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex')
}

describe('runExport — AC #1 file layout', () => {
  it('writes manifest.json + 7 domain files with required manifest fields', () => {
    seedProject('p1', '/repo')
    seedTask('TASK-001', 'p1', 'first')

    const result = runExport({
      outDir: tmp,
      appVersion: '0.2.0',
      db,
      git: localGit(),
      now: () => FROZEN_NOW
    })

    expect(result.status).toBe('written')
    const expected = [
      'projects.json',
      'workspaces.json',
      'tasks.json',
      'conversations.json',
      'inbox.json',
      'sessions.json',
      'knowledge.json',
      'manifest.json'
    ]
    for (const f of expected) {
      expect(fs.existsSync(path.join(tmp, f)), `missing: ${f}`).toBe(true)
    }

    const m = readManifest(tmp)
    expect(m.exportFormatVersion).toBe(1)
    expect(m.appVersion).toBe('0.2.0')
    expect(m.exportedAt).toBe(FROZEN_NOW)
    expect(typeof m.contentHash).toBe('string')
    expect(m.contentHash.length).toBe(64)
    expect(m.projectIds).toEqual(['p1'])
    expect(m.workspaceIdentities).toHaveLength(1)
    expect(m.includesArtifacts).toBe(false)
  })

  it('manifest is written LAST so partial export is detectable', () => {
    seedProject('p1', '/repo')
    runExport({ outDir: tmp, appVersion: '0.2.0', db, git: localGit(), now: () => FROZEN_NOW })
    // mtime of manifest must be ≥ all other files' mtime
    const stats = fs
      .readdirSync(tmp)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ name: f, mtime: fs.statSync(path.join(tmp, f)).mtimeMs }))
    const manifestMtime = stats.find((s) => s.name === 'manifest.json')!.mtime
    for (const s of stats) expect(s.mtime).toBeLessThanOrEqual(manifestMtime)
  })

  it('emits no .tmp leftovers from atomic writes', () => {
    seedProject('p1', '/repo')
    runExport({ outDir: tmp, appVersion: '0.2.0', db, git: localGit(), now: () => FROZEN_NOW })
    const leftovers = fs.readdirSync(tmp).filter((f) => f.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('sorts projectIds in manifest deterministically', () => {
    seedProject('zeta', '/r')
    seedProject('alpha', '/r')
    seedProject('mu', '/r')
    const result = runExport({
      outDir: tmp,
      appVersion: '0.2.0',
      db,
      git: localGit(),
      now: () => FROZEN_NOW
    })
    const m = readManifest(result.outDir)
    expect(m.projectIds).toEqual(['alpha', 'mu', 'zeta'])
  })
})

describe('runExport — AC #12 content-stable export', () => {
  it('AC #12(a) no DB changes + same appVersion → second run is no-op (byte-identical files)', () => {
    seedProject('p1', '/repo')
    seedTask('TASK-001', 'p1', 'one')

    runExport({ outDir: tmp, appVersion: '0.2.0', db, git: localGit(), now: () => FROZEN_NOW })
    const firstHashes = new Map<string, string>()
    for (const f of fs.readdirSync(tmp)) firstHashes.set(f, fileHash(path.join(tmp, f)))

    const second = runExport({
      outDir: tmp,
      appVersion: '0.2.0',
      db,
      git: localGit(),
      now: () => '2099-12-31T23:59:59.000Z'
    })

    expect(second.status).toBe('no-op')
    expect(second.filesWritten).toEqual([])
    for (const f of fs.readdirSync(tmp)) {
      expect(fileHash(path.join(tmp, f)), `file changed: ${f}`).toBe(firstHashes.get(f))
    }
  })

  it('AC #12(b) DB mutation → tasks.json and manifest change; contentHash advances', () => {
    seedProject('p1', '/repo')
    seedTask('TASK-001', 'p1', 'one')
    runExport({ outDir: tmp, appVersion: '0.2.0', db, git: localGit(), now: () => FROZEN_NOW })

    const tasksBefore = fs.readFileSync(path.join(tmp, 'tasks.json'), 'utf8')
    const manifestBefore = readManifest(tmp)
    const projectsHashBefore = fileHash(path.join(tmp, 'projects.json'))

    seedTask('TASK-002', 'p1', 'two')
    const second = runExport({
      outDir: tmp,
      appVersion: '0.2.0',
      db,
      git: localGit(),
      now: () => '2026-05-09T00:00:00.000Z'
    })

    expect(second.status).toBe('written')
    expect(fs.readFileSync(path.join(tmp, 'tasks.json'), 'utf8')).not.toBe(tasksBefore)

    const manifestAfter = readManifest(tmp)
    expect(manifestAfter.contentHash).not.toBe(manifestBefore.contentHash)
    expect(manifestAfter.exportedAt).not.toBe(manifestBefore.exportedAt)
    // projects.json untouched in content
    expect(fileHash(path.join(tmp, 'projects.json'))).toBe(projectsHashBefore)
  })

  it('AC #12(c) workspace identity drift → contentHash + manifest advance', () => {
    seedProject('p1', '/repo')
    runExport({
      outDir: tmp,
      appVersion: '0.2.0',
      db,
      git: gitWithRemote('git@github.com:user/repo.git', '/repo'),
      now: () => FROZEN_NOW
    })
    const before = readManifest(tmp)

    const second = runExport({
      outDir: tmp,
      appVersion: '0.2.0',
      db,
      // Same DB rows, but the remote URL has been re-derived to a different value
      git: gitWithRemote('git@gitlab.com:user/repo.git', '/repo'),
      now: () => '2026-05-09T00:00:00.000Z'
    })

    expect(second.status).toBe('written')
    const after = readManifest(tmp)
    expect(after.contentHash).not.toBe(before.contentHash)
  })

  it('AC #12(e) appVersion drift on identical content → metadata-refresh, only manifest changes', () => {
    seedProject('p1', '/repo')
    seedTask('TASK-001', 'p1', 'one')
    runExport({ outDir: tmp, appVersion: '0.2.0', db, git: localGit(), now: () => FROZEN_NOW })

    const domainHashesBefore: Record<string, string> = {}
    for (const f of fs.readdirSync(tmp)) {
      if (f !== 'manifest.json') domainHashesBefore[f] = fileHash(path.join(tmp, f))
    }
    const manifestBefore = readManifest(tmp)

    const second = runExport({
      outDir: tmp,
      appVersion: '0.3.0',
      db,
      git: localGit(),
      now: () => '2026-05-09T00:00:00.000Z'
    })

    expect(second.status).toBe('metadata-refresh')
    expect(second.filesWritten).toEqual(['manifest.json'])

    const manifestAfter = readManifest(tmp)
    expect(manifestAfter.appVersion).toBe('0.3.0')
    expect(manifestAfter.exportedAt).toBe('2026-05-09T00:00:00.000Z')
    expect(manifestAfter.contentHash).toBe(manifestBefore.contentHash)

    for (const [f, h] of Object.entries(domainHashesBefore)) {
      expect(fileHash(path.join(tmp, f)), `domain file changed unexpectedly: ${f}`).toBe(h)
    }
  })

  it('treats corrupt existing manifest as no previous (writes fresh)', () => {
    seedProject('p1', '/repo')
    fs.writeFileSync(path.join(tmp, 'manifest.json'), '{not json', 'utf8')
    const result = runExport({
      outDir: tmp,
      appVersion: '0.2.0',
      db,
      git: localGit(),
      now: () => FROZEN_NOW
    })
    expect(result.status).toBe('written')
    expect(fs.existsSync(path.join(tmp, 'manifest.json'))).toBe(true)
    const m = readManifest(tmp)
    expect(m.contentHash).toBe(result.contentHash)
  })

  it('round-trip: tasks added, removed, then identical state → final hash matches initial', () => {
    seedProject('p1', '/repo')
    seedTask('TASK-001', 'p1', 'one')
    const first = runExport({
      outDir: tmp,
      appVersion: '0.2.0',
      db,
      git: localGit(),
      now: () => FROZEN_NOW
    })

    seedTask('TASK-002', 'p1', 'two')
    runExport({ outDir: tmp, appVersion: '0.2.0', db, git: localGit(), now: () => FROZEN_NOW })

    db.prepare('DELETE FROM tasks WHERE id = ?').run('TASK-002')
    const third = runExport({
      outDir: tmp,
      appVersion: '0.2.0',
      db,
      git: localGit(),
      now: () => FROZEN_NOW
    })

    expect(third.contentHash).toBe(first.contentHash)
  })
})
