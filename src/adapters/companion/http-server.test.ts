import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { startCompanionServer, COMPANION_BIND, type CompanionServerHandle } from './http-server'
import type { CompanionServices } from './service-factory'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'
import { LEDGER_ENTITIES } from './sync-ledger'
import { ensureLoopStatusColumns, writeLoopHeartbeat } from '../../core/sync/sync-loop-status'
import { createSyncEventsTable, appendSyncEvent } from '../../core/sync/sync-events'
import { SyncNotConfiguredError } from './sync-actions'
import { UnimplementedDestinationError } from './capture-contract'

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
  // seed the sync activity log so /sync/log has events to serve (at ascending →
  // newest by id is also newest by time)
  createSyncEventsTable(db)
  appendSyncEvent(db, { at: 1000, kind: 'pull', upserted: 2 }, 10_000)
  appendSyncEvent(db, { at: 2000, kind: 'push', pushed: 1 }, 10_000)
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
      bridgeToken: 'test-token',
      pull: async () => ({ upserted: 3, tombstoned: 1, cursor: 42 }),
      push: async () => ({ drained: 2, conflicts: 0, remaining: 0, reachable: true }),
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

  it('serves the sync log newest-first and honors ?limit', async () => {
    const all = await (await fetch(`${base}/sync/log`)).json()
    expect(all.events.map((e: { at: number }) => e.at)).toEqual([2000, 1000])
    expect(all.events[0].kind).toBe('push')

    const one = await (await fetch(`${base}/sync/log?limit=1`)).json()
    expect(one.events).toHaveLength(1)
    expect(one.events[0].at).toBe(2000)
  })

  it('rejects a non-GET on /sync/log (read-only)', async () => {
    expect((await fetch(`${base}/sync/log`, { method: 'POST' })).status).toBe(405)
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

  it('POST /sync/pull and /sync/push run the action and return its summary', async () => {
    const pull = await fetch(`${base}/sync/pull`, { method: 'POST' })
    expect(pull.status).toBe(200)
    expect(await pull.json()).toEqual({ upserted: 3, tombstoned: 1, cursor: 42 })

    const push = await fetch(`${base}/sync/push`, { method: 'POST' })
    expect(push.status).toBe(200)
    expect(await push.json()).toEqual({ drained: 2, conflicts: 0, remaining: 0, reachable: true })
  })

  // TASK-1330 — capture bridge on the no-dispatcher fixture.
  const capture = (body: unknown, token = 'test-token'): Promise<Response> =>
    fetch(`${base}/capture`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-choda-bridge-token': token },
      body: JSON.stringify(body)
    })
  const validBody = { kind: 'text', destination: 'inbox', payload: 'hello', sourceUrl: 'http://x' }

  it('POST /capture 401s a missing/bad token', async () => {
    const noHeader = await fetch(`${base}/capture`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody)
    })
    expect(noHeader.status).toBe(401)
    expect((await capture(validBody, 'wrong')).status).toBe(401)
  })

  it('POST /capture 415s a non-JSON content-type', async () => {
    const res = await fetch(`${base}/capture`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-choda-bridge-token': 'test-token' },
      body: 'nope'
    })
    expect(res.status).toBe(415)
  })

  it('POST /capture 400s malformed contract', async () => {
    expect((await capture({ kind: 'bogus', destination: 'inbox', payload: 'x', sourceUrl: 'http://x' })).status).toBe(400)
    expect((await capture({ kind: 'text', destination: 'nope', payload: 'x', sourceUrl: 'http://x' })).status).toBe(400)
    expect((await capture({ kind: 'text', destination: 'inbox', sourceUrl: 'http://x' })).status).toBe(400)
    expect((await capture({ kind: 'text', destination: 'inbox', payload: 'x' })).status).toBe(400)
  })

  it('POST /capture 413s an over-cap body', async () => {
    const big = { ...validBody, payload: 'x'.repeat(64 * 1024 + 1) }
    expect((await capture(big)).status).toBe(413)
  })

  it('POST /capture 501s a well-formed capture when no dispatcher is wired', async () => {
    const res = await capture(validBody)
    expect(res.status).toBe(501)
    expect((await res.json()).error).toMatch(/not implemented/i)
  })
})

describe('companion http server — capture dispatch', () => {
  it('routes a valid capture through the dispatcher and 501s an unimplemented destination', async () => {
    const db = fixtureDb()
    const services: CompanionServices = {
      svc: fakeSvc,
      db,
      dbPath: ':memory:',
      intervalMs: 30000,
      bridgeToken: 'tok',
      dispatch: {
        dispatch: async (c) => {
          if (c.destination === 'knowledge') throw new UnimplementedDestinationError('knowledge')
          return { id: 'INBOX-9', destination: c.destination }
        }
      },
      pull: async () => ({ upserted: 0, tombstoned: 0, cursor: 0 }),
      push: async () => ({ drained: 0, conflicts: 0, remaining: 0, reachable: true }),
      close: () => db.close()
    }
    const handle = await startCompanionServer(services, 0)
    const base = `http://${COMPANION_BIND}:${handle.address.port}`
    const post = (body: unknown): Promise<Response> =>
      fetch(`${base}/capture`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-choda-bridge-token': 'tok' },
        body: JSON.stringify(body)
      })
    try {
      const ok = await post({ kind: 'text', destination: 'inbox', payload: 'hi', sourceUrl: 'http://x' })
      expect(ok.status).toBe(200)
      expect(await ok.json()).toEqual({ id: 'INBOX-9', destination: 'inbox' })

      const notImpl = await post({ kind: 'text', destination: 'knowledge', payload: 'hi', sourceUrl: 'http://x' })
      expect(notImpl.status).toBe(501)
    } finally {
      await handle.close()
      db.close()
    }
  })
})

describe('companion http server — sync not configured', () => {
  it('returns 409 (not a silent success) when the laptop has no remote', async () => {
    const db = fixtureDb()
    const services: CompanionServices = {
      svc: fakeSvc,
      db,
      dbPath: ':memory:',
      intervalMs: 30000,
      bridgeToken: 'test-token',
      pull: async () => {
        throw new SyncNotConfiguredError('sync is not configured')
      },
      push: async () => {
        throw new SyncNotConfiguredError('sync is not configured')
      },
      close: () => db.close()
    }
    const handle = await startCompanionServer(services, 0)
    try {
      const res = await fetch(`http://${COMPANION_BIND}:${handle.address.port}/sync/pull`, {
        method: 'POST'
      })
      expect(res.status).toBe(409)
      expect((await res.json()).error).toMatch(/not configured/i)
    } finally {
      await handle.close()
      db.close()
    }
  })
})
