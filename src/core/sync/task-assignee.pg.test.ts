// TASK-2246 — tasks.assignee on Postgres: the column exists, a laptop
// task_update reaches Postgres through one real drain cycle, and the Postgres
// repository's assignee filter agrees with SQLite. Self-skips without Docker.

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

const TOKEN = 'assignee-token'
const DEAD_URL = 'http://127.0.0.1:1'

describeIfDocker('TASK-2246 — task assignee on Postgres', () => {
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
    if (local) await local.close()
    if (server) await server.close()
    if (env) await stopPostgresTestEnv(env)
  }, 30_000)

  it('AC-1: the Postgres tasks table has an assignee column', async () => {
    const cols = await env.conn.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'tasks'"
    )
    expect(cols.rows.map((r) => r.column_name)).toContain('assignee')
  })

  it('AC-7: a laptop task_update with assignee "an" reaches Postgres after one drain cycle', async () => {
    const offline = wrapWithSyncWriteThrough(local, new HttpWriteClient({ remoteUrl: DEAD_URL, token: TOKEN }))
    const task = await offline.createTask({ projectId: 'p', title: 'to assign' })
    await offline.updateTask(task.id, { assignee: 'an' })
    expect(countPendingOps(local.syncDatabase)).toBeGreaterThan(0)

    const loop = startSyncLoop({ db: local.syncDatabase, remoteUrl, token: TOKEN, intervalMs: 10_000_000 })
    await loop.runOnce()
    loop.stop()
    expect(countPendingOps(local.syncDatabase)).toBe(0)

    const pg = await env.conn.query<{ assignee: string | null }>('SELECT assignee FROM tasks WHERE id = $1', [task.id])
    expect(pg.rows[0]?.assignee).toBe('an')
  })

  it('AC-8: the Postgres assignee filter returns the same id set as SQLite', async () => {
    const fixture: Array<[string, string | null, string]> = [
      ['TASK-A1', 'an', 'TODO'],
      ['TASK-A2', 'an', 'TODO'],
      ['TASK-B1', 'binh', 'TODO'],
      ['TASK-N1', null, 'TODO'],
      ['TASK-A3', 'an', 'DONE']
    ]
    await env.conn.query("INSERT INTO projects (id, name, cwd) VALUES ('q', 'Q', '/q')")
    for (const [id, assignee, status] of fixture) {
      await env.conn.query(
        `INSERT INTO tasks (id, project_id, title, status, labels, pinned, assignee, created_at, updated_at)
         VALUES ($1, 'q', $1, $2, '[]', false, $3, NOW(), NOW())`,
        [id, status, assignee]
      )
      await local.createTask({
        id,
        projectId: 'q',
        title: id,
        status: status as 'TODO' | 'DONE',
        assignee: assignee ?? undefined
      })
    }
    const pgIds = (await pgSvc.findTasks({ projectId: 'q', status: 'TODO', assignee: 'an' })).map((t) => t.id).sort()
    const sqliteIds = (await local.findTasks({ projectId: 'q', status: 'TODO', assignee: 'an' }))
      .map((t) => t.id)
      .sort()
    expect(pgIds).toEqual(['TASK-A1', 'TASK-A2'])
    expect(sqliteIds).toEqual(pgIds)
  })
})
