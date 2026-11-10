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
import { getLastPullAt } from './lamport-clock'

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

  // TASK-2200 — org set on one laptop reaches canonical PG and a second laptop,
  // including an org assigned later to a project both already hold.
  it('project org syncs laptop → PG → laptop, on create and on a later update', async () => {
    const lap1 = new SqliteTaskService(':memory:')
    const wrapped = wrapWithSyncWriteThrough(lap1, new HttpWriteClient({ remoteUrl, token: TOKEN }))
    await wrapped.ensureProject('hc', 'Headless CMS', 'C:/dev/test/headless-cms', 'ichiba')
    await wrapped.ensureProject('mk', 'Infrastructure', 'C:/dev/micro_k8s')

    const pg = await env.conn.query<{ id: string; org: string | null }>(
      'SELECT id, org FROM projects WHERE id = ANY($1) ORDER BY id',
      [['hc', 'mk']]
    )
    expect(pg.rows).toEqual([
      { id: 'hc', org: 'ichiba' },
      { id: 'mk', org: null }
    ])

    const lap2 = new SqliteTaskService(':memory:')
    const loop2 = startSyncLoop({ db: lap2.syncDatabase, remoteUrl, token: TOKEN, intervalMs: 10_000_000 })
    await loop2.runOnce()
    expect((await lap2.getProject('hc'))?.org).toBe('ichiba')
    expect((await lap2.getProject('mk'))?.org).toBeNull()

    // lap1 has never pulled, so its clock is still at ~2 while lap2's cursor is
    // already past every row canonical holds. TASK-3202: canonical re-stamps the
    // update above its own clock, so lap2 still receives it.
    await wrapped.ensureProject('mk', 'Infrastructure', 'C:/dev/micro_k8s', 'personal')
    await loop2.runOnce()
    loop2.stop()
    expect((await lap2.getProject('mk'))?.org).toBe('personal')
    expect((await pgSvc.listProjects('personal')).map((p) => p.id)).toEqual(['mk'])

    lap1.close()
    lap2.close()
  })

  // TASK-3202 AC-1 / AC-3 — the bug itself: a fresh node that writes before its
  // first pull. Its rows are stamped 1..n, below the cursor every synced node
  // holds; `since` is strictly greater-than, so without the re-stamp nobody
  // would ever fetch them.
  it('a fresh node that never pulled still reaches a node whose cursor is already ahead', async () => {
    // Seed canonical so a synced node's cursor is well above a fresh clock.
    const seeder = wrapWithSyncWriteThrough(
      new SqliteTaskService(':memory:'),
      new HttpWriteClient({ remoteUrl, token: TOKEN })
    )
    await seeder.ensureProject('seed', 'Seed', 'C:/dev/seed')
    for (let i = 0; i < 5; i++) await seeder.createTask({ projectId: 'seed', title: `seed ${i}` })

    const lapB = new SqliteTaskService(':memory:')
    const loopB = startSyncLoop({ db: lapB.syncDatabase, remoteUrl, token: TOKEN, intervalMs: 10_000_000 })
    await loopB.runOnce()
    const cursorB = getLastPullAt(lapB.syncDatabase)
    expect(cursorB).toBeGreaterThan(1)

    // Node A: fresh DB, NO pull, writes straight away (offline at boot / first
    // tool call before the first sync cycle).
    const lapA = new SqliteTaskService(':memory:')
    const wrappedA = wrapWithSyncWriteThrough(lapA, new HttpWriteClient({ remoteUrl, token: TOKEN }))
    await wrappedA.ensureProject('fresh', 'Fresh Node Project', 'C:/dev/fresh')

    // AC-3 — after the push the local row equals the canonical row, and both sit
    // above B's cursor.
    const localA = lapA.syncDatabase
      .prepare('SELECT sync_updated_at FROM projects WHERE id = ?')
      .get('fresh') as { sync_updated_at: number }
    const pg = await env.conn.query<{ sync_updated_at: string }>(
      'SELECT sync_updated_at FROM projects WHERE id = $1',
      ['fresh']
    )
    expect(Number(pg.rows[0]?.sync_updated_at)).toBe(localA.sync_updated_at)
    expect(localA.sync_updated_at).toBeGreaterThan(cursorB)

    // AC-1 — B pulls and receives it.
    await loopB.runOnce()
    loopB.stop()
    expect((await lapB.getProject('fresh'))?.name).toBe('Fresh Node Project')

    lapA.close()
    lapB.close()
  })
})
