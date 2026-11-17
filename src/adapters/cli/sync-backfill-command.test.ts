import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import Database from 'better-sqlite3'
import { initSchema } from '../../core/domain/repositories/schema'
import { syncBackfillCommand } from './sync-backfill-command'
import type { ApplySink } from '../../core/sync/sync-apply'

const failingSink: ApplySink = {
  applyDelta: async () => {
    throw new Error('HTTP 502')
  }
}

describe('syncBackfillCommand', () => {
  let dir: string
  let dbPath: string
  let out: string
  let err: string
  const io = {
    out: (s: string): void => {
      out += s
    },
    err: (s: string): void => {
      err += s
    }
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-backfill-'))
    dbPath = path.join(dir, 'choda-deck.db')
    const db = new Database(dbPath)
    initSchema(db)
    db.prepare(`INSERT INTO projects (id, name, cwd) VALUES ('algorithms', 'Algo', '/r/a')`).run()
    db.close()
    out = ''
    err = ''
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('exits 0 and prints the failure count when the remote push fails', async () => {
    const code = await syncBackfillCommand([], io, { dbPath, sink: failingSink })

    expect(code).toBe(0)
    expect(out).toContain('projects: stamped 1 · pushed 0 · conflicts 0 · queued 1')
    expect(out).toContain('push failed, rows queued to pending_ops: HTTP 502')
    const db = new Database(dbPath)
    expect((db.prepare('SELECT count(*) n FROM pending_ops').get() as { n: number }).n).toBe(1)
    db.close()
  })

  it('prints usage on --help without touching the database', async () => {
    const code = await syncBackfillCommand(['--help'], io, { dbPath: path.join(dir, 'none.db') })

    expect(code).toBe(0)
    expect(out).toContain('Usage: choda-deck sync backfill')
    expect(fs.existsSync(path.join(dir, 'none.db'))).toBe(false)
  })

  it('exits 2 when no remote is configured', async () => {
    const saved = process.env.CHODA_PULL_REMOTE_URL
    delete process.env.CHODA_PULL_REMOTE_URL
    try {
      expect(await syncBackfillCommand([], io, { dbPath })).toBe(2)
      expect(err).toContain('requires CHODA_PULL_REMOTE_URL')
    } finally {
      if (saved !== undefined) process.env.CHODA_PULL_REMOTE_URL = saved
    }
  })
})
