import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { startCompanionServer, COMPANION_BIND, type CompanionServerHandle } from './http-server'
import type { CompanionServices } from './service-factory'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'
import { LEDGER_ENTITIES } from './sync-ledger'
import { ensureLoopStatusColumns, writeLoopHeartbeat } from '../../core/sync/sync-loop-status'

function fixtureDb(): Database.Database {
  const db = new Database(':memory:')
  for (const { table } of LEDGER_ENTITIES) {
    db.exec(
      `CREATE TABLE ${table} (id TEXT PRIMARY KEY, sync_origin TEXT, sync_updated_at INTEGER, sync_deleted_at INTEGER)`
    )
  }
  db.exec(`CREATE TABLE _sync_state (id INTEGER PRIMARY KEY CHECK (id = 0), last_pull_at INTEGER NOT NULL DEFAULT 0)`)
  db.exec('INSERT INTO _sync_state (id, last_pull_at) VALUES (0, 0)')
  ensureLoopStatusColumns(db)
  // one remote-origin task so the ledger has a non-zero remote-only bucket
  db.prepare(
    `INSERT INTO tasks (id, sync_origin, sync_updated_at, sync_deleted_at) VALUES ('TASK-1', 'remote', 5, NULL)`
  ).run()
  return db
}

// Minimal fake — the router only touches these four read methods.
const fakeSvc = {
  listProjects: async () => [{ id: 'choda-deck' }],
  findTasks: async () => [{ id: 'TASK-1', title: 't' }],
  findInbox: async () => [{ id: 'INBOX-1' }],
  findConversations: async () => [{ id: 'CONV-1' }]
} as unknown as BackendTaskService

describe('companion http server', () => {
  let handle: CompanionServerHandle
  let base: string
  const db = fixtureDb()

  beforeAll(async () => {
    writeLoopHeartbeat(db, {
      at: new Date().toISOString(),
      pulled: true,
      reachable: true,
      jwtState: 'refresh'
    })
    const services: CompanionServices = {
      svc: fakeSvc,
      db,
      dbPath: ':memory:',
      intervalMs: 30000,
      close: () => db.close()
    }
    handle = await startCompanionServer(services, 0)
    base = `http://${COMPANION_BIND}:${handle.address.port}`
  })

  afterAll(async () => {
    await handle.close()
    db.close()
  })

  it('binds to 127.0.0.1 only', () => {
    expect(handle.address.bind).toBe('127.0.0.1')
  })

  it('serves the read endpoints', async () => {
    const start = Date.now()
    const tasks = await (await fetch(`${base}/tasks`)).json()
    expect(Date.now() - start).toBeLessThan(1000) // AC-5
    expect(tasks).toEqual({ tasks: [{ id: 'TASK-1', title: 't' }] })

    expect(await (await fetch(`${base}/projects`)).json()).toEqual({ projects: [{ id: 'choda-deck' }] })
    expect(await (await fetch(`${base}/inbox`)).json()).toEqual({ inbox: [{ id: 'INBOX-1' }] })
    expect(await (await fetch(`${base}/conversations`)).json()).toEqual({
      conversations: [{ id: 'CONV-1' }]
    })
  })

  it('serves the sync ledger with the remote-only row counted', async () => {
    const body = await (await fetch(`${base}/sync/ledger`)).json()
    const tasks = body.ledger.find((r: { entity: string }) => r.entity === 'tasks')
    expect(tasks).toEqual({ entity: 'tasks', inSync: 0, localOnly: 0, remoteOnly: 1, tombstoned: 0 })
  })

  it('serves health with no credential in the body', async () => {
    const res = await fetch(`${base}/sync/health`)
    const body = await res.json()
    expect(body.loopAlive).toBe(true)
    expect(Object.keys(body).sort()).toEqual(['jwtState', 'lastPullAgeSec', 'loopAlive', 'reachable'])
    // jwtState is a posture label, never a token value
    expect(JSON.stringify(body)).not.toMatch(/Bearer|eyJ|token/i)
  })

  it('404s an unknown path and 405s a non-GET', async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404)
    expect((await fetch(`${base}/tasks`, { method: 'POST' })).status).toBe(405)
  })
})
