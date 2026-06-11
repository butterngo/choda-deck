// ADR-030 Phase 5+6 (979d) — end-to-end sync smoke against real Postgres.
// Offline write (enqueued) → reconnect drain → canonical convergence →
// idempotent re-pull. Self-skips when Docker is unavailable.

import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  describeIfDocker,
  startPostgresTestEnv,
  stopPostgresTestEnv,
  type PgTestEnv
} from '../../test/postgres-harness'
import { PostgresTaskService } from '../domain/postgres-task-service'
import { SqliteTaskService } from '../domain/sqlite-task-service'
import { startHttpTransport, type HttpTransportHandle } from '../../adapters/mcp/http-transport'
import { wrapWithSyncWriteThrough } from './sync-write-through'
import { HttpWriteClient } from './http-write-client'
import { startSyncLoop } from './sync-loop'
import { countPendingOps } from './pending-ops'

const TOKEN = 'e2e-token'
const DEAD_URL = 'http://127.0.0.1:1' // connection refused → write-through enqueues

describeIfDocker('ADR-030 Phase 5+6 — offline write → drain → converge', () => {
  let env: PgTestEnv
  let pgSvc: PostgresTaskService
  let server: HttpTransportHandle
  let remoteUrl: string
  let local: SqliteTaskService

  beforeAll(async () => {
    env = await startPostgresTestEnv()
    pgSvc = new PostgresTaskService(env.conn)
    await pgSvc.initializeAsync()
    await env.conn.query("INSERT INTO projects (id, name, cwd) VALUES ('p', 'P', '/p')")
    server = await startHttpTransport(() => Promise.reject(new Error('mcp factory unused')), {
      port: 0,
      bind: '127.0.0.1',
      token: TOKEN,
      syncSource: { fetchSince: (since) => pgSvc.fetchSince(since) },
      syncSink: { applyDelta: (deltas, origin) => pgSvc.applyDelta(deltas, origin) }
    })
    remoteUrl = `http://127.0.0.1:${server.address.port}`
    local = new SqliteTaskService(':memory:')
  }, 120_000)

  afterAll(async () => {
    if (local) local.close()
    if (server) await server.close()
    if (env) await stopPostgresTestEnv(env)
  }, 30_000)

  it('write offline → drain on reconnect → PG converges → re-pull is a no-op', async () => {
    // Phase A — offline: write-through points at a dead URL, so the push fails
    // and the op lands in pending_ops while the tool call still succeeds.
    const offline = wrapWithSyncWriteThrough(local, new HttpWriteClient({ remoteUrl: DEAD_URL, token: TOKEN }))
    const task = await offline.createTask({ projectId: 'p', title: 'offline-write' })
    expect(countPendingOps(local.syncDatabase)).toBe(1)

    // Phase B — reconnect: the loop drains the queue to the real server, then pulls.
    const loop = startSyncLoop({
      db: local.syncDatabase,
      remoteUrl,
      token: TOKEN,
      intervalMs: 10_000_000
    })
    await loop.runOnce()
    expect(countPendingOps(local.syncDatabase)).toBe(0)

    // Phase C — convergence: the task is now canonical in Postgres.
    const pg = await env.conn.query<{ title: string }>('SELECT title FROM tasks WHERE id = $1', [task.id])
    expect(pg.rows[0]?.title).toBe('offline-write')

    // Phase D — idempotent: a second cycle changes nothing and does not throw.
    await loop.runOnce()
    loop.stop()
    expect(countPendingOps(local.syncDatabase)).toBe(0)
    const pg2 = await env.conn.query('SELECT COUNT(*)::int AS n FROM tasks')
    expect((pg2.rows[0] as { n: number }).n).toBe(1)
  })
})
