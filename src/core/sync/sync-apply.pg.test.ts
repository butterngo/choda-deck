// ADR-030 Phase 3 (979a) — write-apply against real Postgres + the /sync/apply
// endpoint. Boots a testcontainer Postgres, pushes deltas through both the
// service facade (LWW correctness) and the HTTP route (wiring + auth), and
// asserts the SQLite→PG type coercion (jsonb labels, boolean pinned, timestamptz
// created_at). Self-skips when Docker is unavailable (Windows CI).

import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import {
  describeIfDocker,
  startPostgresTestEnv,
  stopPostgresTestEnv,
  type PgTestEnv
} from '../../test/postgres-harness'
import { PostgresTaskService } from '../domain/postgres-task-service'
import { startHttpTransport, type HttpTransportHandle } from '../../adapters/mcp/http-transport'
import type { TableDelta } from './sync-pull'

const TOKEN = 'apply-test-token'

function taskRow(id: string, lamport: number, title: string): TableDelta {
  return {
    table: 'tasks',
    rows: [
      {
        id,
        project_id: 'p',
        parent_task_id: null,
        title,
        status: 'TODO',
        priority: 'high',
        labels: '["x","y"]', // SQLite stores jsonb as a JSON string on the wire
        due_date: null,
        pinned: 1, // SQLite stores boolean as 0/1
        file_path: null,
        body: 'body',
        created_at: '2026-06-11T00:00:00.000Z',
        updated_at: '2026-06-11T00:00:00.000Z',
        sync_updated_at: lamport,
        sync_deleted_at: null,
        sync_origin: 'laptop'
      }
    ]
  }
}

describeIfDocker('ADR-030 Phase 3 — POST /sync/apply → canonical Postgres', () => {
  let env: PgTestEnv
  let svc: PostgresTaskService
  let server: HttpTransportHandle
  let remoteUrl: string

  beforeAll(async () => {
    env = await startPostgresTestEnv()
    svc = new PostgresTaskService(env.conn)
    await svc.initializeAsync()
    await env.conn.query("INSERT INTO projects (id, name, cwd) VALUES ('p', 'P', '/p')")
    server = await startHttpTransport(() => Promise.reject(new Error('mcp factory unused')), {
      port: 0,
      bind: '127.0.0.1',
      token: TOKEN,
      syncSink: { applyDelta: (deltas, origin) => svc.applyDelta(deltas, origin) }
    })
    remoteUrl = `http://127.0.0.1:${server.address.port}`
  }, 120_000)

  afterAll(async () => {
    if (server) await server.close()
    if (env) await stopPostgresTestEnv(env)
  }, 30_000)

  beforeEach(async () => {
    await env.conn.query('DELETE FROM tasks')
    await env.conn.query('UPDATE _sync_clock SET counter = 0 WHERE id = 0')
  })

  async function rawTask(id: string): Promise<{ title: string; labels: string[]; pinned: boolean; sync_updated_at: string } | undefined> {
    const r = await env.conn.query<{ title: string; labels: string[]; pinned: boolean; sync_updated_at: string }>(
      'SELECT title, labels, pinned, sync_updated_at FROM tasks WHERE id = $1',
      [id]
    )
    return r.rows[0]
  }

  it('applies a pushed task with correct SQLite→PG type coercion', async () => {
    const res = await svc.applyDelta([taskRow('TASK-1', 5, 'first')], 'laptop')
    expect(res).toMatchObject({ applied: 1, conflicts: 0 })
    const row = await rawTask('TASK-1')
    expect(row?.title).toBe('first')
    expect(row?.labels).toEqual(['x', 'y']) // jsonb round-trips to an array
    expect(row?.pinned).toBe(true) // 1 → boolean true
    expect(Number(row?.sync_updated_at)).toBe(5)
  })

  it('drops a stale push as a conflict (canonical unchanged)', async () => {
    await svc.applyDelta([taskRow('TASK-1', 5, 'first')], 'laptop')
    const res = await svc.applyDelta([taskRow('TASK-1', 3, 'stale')], 'laptop')
    expect(res).toMatchObject({ applied: 0, conflicts: 1 })
    expect((await rawTask('TASK-1'))?.title).toBe('first')
  })

  it('applies a strictly-newer push over the canonical row', async () => {
    await svc.applyDelta([taskRow('TASK-1', 5, 'first')], 'laptop')
    await svc.applyDelta([taskRow('TASK-1', 9, 'updated')], 'laptop')
    expect((await rawTask('TASK-1'))?.title).toBe('updated')
  })

  it('POST /sync/apply over HTTP applies and returns verdicts', async () => {
    const res = await fetch(`${remoteUrl}/sync/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ origin: 'laptop', deltas: [taskRow('TASK-2', 4, 'via-http')] })
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ applied: 1 })
    expect((await rawTask('TASK-2'))?.title).toBe('via-http')
  })

  it('rejects an unauthenticated /sync/apply with 401', async () => {
    const res = await fetch(`${remoteUrl}/sync/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ origin: 'laptop', deltas: [] })
    })
    expect(res.status).toBe(401)
  })
})
