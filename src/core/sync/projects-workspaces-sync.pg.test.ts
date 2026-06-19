// TASK-1146 — project + workspace sync against real Postgres: a sync laptop
// creates a project, workspace, and task; all three land on canonical PG and a
// second laptop pulls them with FK order intact. Self-skips without Docker.

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

const TOKEN = 'pw-e2e-token'

describeIfDocker('TASK-1146 — project + workspace sync laptop → PG → laptop', () => {
  let env: PgTestEnv
  let pgSvc: PostgresTaskService
  let server: HttpTransportHandle
  let remoteUrl: string

  beforeAll(async () => {
    env = await startPostgresTestEnv()
    pgSvc = new PostgresTaskService(env.conn)
    await pgSvc.initializeAsync()
    server = await startHttpTransport(() => Promise.reject(new Error('mcp factory unused')), {
      port: 0,
      bind: '127.0.0.1',
      token: TOKEN,
      syncSource: { fetchSince: (since) => pgSvc.fetchSince(since) },
      syncSink: { applyDelta: (deltas, origin) => pgSvc.applyDelta(deltas, origin) }
    })
    remoteUrl = `http://127.0.0.1:${server.address.port}`
  }, 120_000)

  afterAll(async () => {
    if (server) await server.close()
    if (env) await stopPostgresTestEnv(env)
  }, 30_000)

  it('project + workspace + task push to canonical PG (FK order holds) and pull back', async () => {
    const lap1 = new SqliteTaskService(':memory:')
    const wrapped = wrapWithSyncWriteThrough(lap1, new HttpWriteClient({ remoteUrl, token: TOKEN }))

    // Parent-first: project, then workspace, then a task in it.
    await wrapped.ensureProject('ec', 'English Companion', 'C:/dev/english-companion')
    await wrapped.addWorkspace('ec', 'web', 'Web', 'C:/dev/english-companion')
    const task = await wrapped.createTask({ projectId: 'ec', title: 'Scaffold PWA shell' })

    // Canonical PG has all three (FK satisfied — project applied before workspace/task).
    const proj = await env.conn.query<{ name: string }>('SELECT name FROM projects WHERE id = $1', ['ec'])
    expect(proj.rows[0]?.name).toBe('English Companion')
    const ws = await env.conn.query<{ label: string }>('SELECT label FROM workspaces WHERE id = $1', ['web'])
    expect(ws.rows[0]?.label).toBe('Web')
    const pgTask = await env.conn.query<{ title: string }>('SELECT title FROM tasks WHERE id = $1', [task.id])
    expect(pgTask.rows[0]?.title).toBe('Scaffold PWA shell')

    // A second laptop pulls them, FK order intact.
    const lap2 = new SqliteTaskService(':memory:')
    const loop2 = startSyncLoop({ db: lap2.syncDatabase, remoteUrl, token: TOKEN, intervalMs: 10_000_000 })
    await loop2.runOnce()
    loop2.stop()

    expect((await lap2.getProject('ec'))?.name).toBe('English Companion')
    expect((await lap2.findWorkspaces('ec')).map((w) => w.id)).toContain('web')
    expect((await lap2.getTask(task.id))?.title).toBe('Scaffold PWA shell')

    lap1.close()
    lap2.close()
  })
})
