// ADR-030 Phase 2 end-to-end (TASK-978) — the Test Plan §4 smoke, automated.
//
// Boots a real Postgres (testcontainers), stamps inbox_add via the PG facade,
// serves GET /sync/since over a real HTTP transport, then pulls remote→local
// through HttpPullSource into a fresh SQLite DB and asserts the rows propagate.
// Self-skips when Docker is unavailable (Windows CI).

import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import {
  describeIfDocker,
  startPostgresTestEnv,
  stopPostgresTestEnv,
  type PgTestEnv
} from '../../test/postgres-harness'
import { PostgresTaskService } from '../domain/postgres-task-service'
import { initSchema } from '../domain/repositories/schema'
import { startHttpTransport, type HttpTransportHandle } from '../../adapters/mcp/http-transport'
import { HttpPullSource } from './http-pull-source'
import { pull } from './sync-pull'
import { getLastPullAt } from './lamport-clock'

const TOKEN = 'phase2-test-token'

describeIfDocker('ADR-030 Phase 2 — remote stamp → pull → local', () => {
  let env: PgTestEnv
  let svc: PostgresTaskService
  let server: HttpTransportHandle
  let remoteUrl: string

  beforeAll(async () => {
    env = await startPostgresTestEnv()
    svc = new PostgresTaskService(env.conn)
    await svc.initializeAsync()
    server = await startHttpTransport(() => Promise.reject(new Error('mcp factory unused')), {
      port: 0,
      bind: '127.0.0.1',
      token: TOKEN,
      syncSource: { fetchSince: (since) => svc.fetchSince(since) }
    })
    remoteUrl = `http://127.0.0.1:${server.address.port}`
  }, 120_000)

  afterAll(async () => {
    if (server) await server.close()
    if (env) await stopPostgresTestEnv(env)
  }, 30_000)

  beforeEach(async () => {
    await env.conn.query('DELETE FROM inbox_items')
    await env.conn.query('UPDATE _sync_clock SET counter = 0 WHERE id = 0')
  })

  async function rawInbox(id: string): Promise<{ sync_updated_at: number; sync_origin: string }> {
    const r = await env.conn.query<{ sync_updated_at: string; sync_origin: string }>(
      'SELECT sync_updated_at, sync_origin FROM inbox_items WHERE id = $1',
      [id]
    )
    return { sync_updated_at: Number(r.rows[0].sync_updated_at), sync_origin: r.rows[0].sync_origin }
  }

  it('stamps inbox_add with a monotonic Lamport tick + origin=remote', async () => {
    const a = await svc.createInbox({ projectId: 'p', content: 'first' })
    const b = await svc.createInbox({ projectId: 'p', content: 'second' })
    const ra = await rawInbox(a.id)
    const rb = await rawInbox(b.id)
    expect(ra.sync_origin).toBe('remote')
    expect(ra.sync_updated_at).toBe(1)
    expect(rb.sync_updated_at).toBe(2)
  })

  it('GET /sync/since returns rows past the cursor only', async () => {
    await svc.createInbox({ projectId: 'p', content: 'first' }) // lamport 1
    await svc.createInbox({ projectId: 'p', content: 'second' }) // lamport 2
    const source = new HttpPullSource({ remoteUrl, token: TOKEN })
    const all = await source.fetchSince(0)
    expect(all.find((d) => d.table === 'inbox_items')?.rows).toHaveLength(2)
    const past1 = await source.fetchSince(1)
    expect(past1.find((d) => d.table === 'inbox_items')?.rows).toHaveLength(1)
  })

  it('rejects an unauthenticated /sync/since with 401', async () => {
    const res = await fetch(`${remoteUrl}/sync/since?since=0`)
    expect(res.status).toBe(401)
  })

  it('end-to-end: a remote inbox_add becomes visible on local SQLite after pull', async () => {
    const created = await svc.createInbox({
      projectId: 'p',
      content: 'from mobile',
      workspaceId: 'main'
    })

    const local = new Database(':memory:')
    try {
      initSchema(local)
      const source = new HttpPullSource({ remoteUrl, token: TOKEN })
      const result = await pull(local, source)

      const row = local.prepare('SELECT content, sync_origin, sync_updated_at FROM inbox_items WHERE id = ?').get(
        created.id
      ) as { content: string; sync_origin: string; sync_updated_at: number } | undefined

      expect(row).toEqual({ content: 'from mobile', sync_origin: 'remote', sync_updated_at: 1 })
      expect(result.counts.find((c) => c.table === 'inbox_items')).toMatchObject({ upserted: 1 })
      expect(getLastPullAt(local)).toBe(1)

      // Idempotent: a second pull past the advanced cursor changes nothing.
      const second = await pull(local, source)
      expect(second.counts.every((c) => c.upserted === 0)).toBe(true)
    } finally {
      local.close()
    }
  })
})
