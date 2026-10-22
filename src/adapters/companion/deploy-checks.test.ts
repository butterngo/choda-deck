import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { SqliteTaskService } from '../../core/domain/sqlite-task-service'
import { wrapWithSyncWriteThrough } from '../../core/sync/sync-write-through'
import type { ApplySink, ApplyResult } from '../../core/sync/sync-apply'
import { applyDeltaToSqlite } from '../../core/sync/sync-sink'
import type { TableDelta } from '../../core/sync/sync-pull'
import { handleDeployChecksRoute } from './deploy-checks'

// TASK-2605 — GET/POST /runs/<goal>/deploy-checks over real HTTP and a real
// SQLite service, and the tick's trip through the sync push.

const TOKEN = 'tok'
let tmp: string
let svc: SqliteTaskService
let server: Server
let base: string

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-checks-'))
  svc = new SqliteTaskService(path.join(tmp, 'test.db'))
  await svc.ensureProject('p', 'P', tmp)
  await svc.createTask({ id: 'TASK-10', projectId: 'p', title: 'Goal', status: 'READY' })
  server = createServer((req, res) => {
    handleDeployChecksRoute(req, res, { svc, bridgeToken: TOKEN }).then((handled) => {
      if (!handled) {
        res.writeHead(418)
        res.end()
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  await svc.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

type Checks = Record<'qc' | 'prod', Record<string, { doneBy: string; doneAt: string; note: string | null }>>

const call = (method: string, goal: string, body?: unknown, token: string | null = TOKEN): Promise<Response> =>
  fetch(`${base}/runs/${goal}/deploy-checks`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { 'x-choda-bridge-token': token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  })

const getChecks = async (): Promise<Checks> => (await (await call('GET', 'TASK-10')).json()) as Checks

describe('deploy checks routes', () => {
  it('AC-1: a QC tick is read back with doneBy butter', async () => {
    expect((await call('POST', 'TASK-10', { env: 'qc', itemKey: 'migration:x', done: true })).status).toBe(200)
    expect((await getChecks()).qc['migration:x'].doneBy).toBe('butter')
  })

  it('AC-2: that GET returns an empty prod object', async () => {
    await call('POST', 'TASK-10', { env: 'qc', itemKey: 'migration:x', done: true })
    expect((await getChecks()).prod).toEqual({})
  })

  it('AC-3: done false removes the key from the next GET', async () => {
    await call('POST', 'TASK-10', { env: 'qc', itemKey: 'migration:x', done: true })
    await call('POST', 'TASK-10', { env: 'qc', itemKey: 'migration:x', done: false })
    expect((await getChecks()).qc).toEqual({})
  })

  it('AC-4: after the un-tick the row keeps a non-null sync_deleted_at', async () => {
    await call('POST', 'TASK-10', { env: 'qc', itemKey: 'migration:x', done: true })
    await call('POST', 'TASK-10', { env: 'qc', itemKey: 'migration:x', done: false })
    const row = svc.syncDatabase
      .prepare('SELECT sync_deleted_at FROM deploy_checks WHERE goal_task_id = ? AND env = ? AND item_key = ?')
      .get('TASK-10', 'qc', 'migration:x') as { sync_deleted_at: number | null }
    expect(row.sync_deleted_at).not.toBeNull()
  })

  it('a re-tick after an un-tick brings the key back', async () => {
    await call('POST', 'TASK-10', { env: 'prod', itemKey: 'sql:a.sql', done: true, note: 'record.md' })
    await call('POST', 'TASK-10', { env: 'prod', itemKey: 'sql:a.sql', done: false })
    await call('POST', 'TASK-10', { env: 'prod', itemKey: 'sql:a.sql', done: true })
    expect(Object.keys((await getChecks()).prod)).toEqual(['sql:a.sql'])
  })

  it('AC-5: env staging answers 400', async () => {
    expect((await call('POST', 'TASK-10', { env: 'staging', itemKey: 'migration:x', done: true })).status).toBe(400)
  })

  it('a missing itemKey answers 400', async () => {
    expect((await call('POST', 'TASK-10', { env: 'qc', done: true })).status).toBe(400)
  })

  it('AC-6: an unknown goal answers 404', async () => {
    expect((await call('GET', 'TASK-999')).status).toBe(404)
    expect((await call('POST', 'TASK-999', { env: 'qc', itemKey: 'x', done: true })).status).toBe(404)
  })

  it('AC-7: a request without the bridge token answers 401', async () => {
    expect((await call('GET', 'TASK-10', undefined, null)).status).toBe(401)
    expect((await call('POST', 'TASK-10', { env: 'qc', itemKey: 'x', done: true }, null)).status).toBe(401)
  })
})

class RecordingSink implements ApplySink {
  calls: TableDelta[][] = []
  async applyDelta(deltas: TableDelta[]): Promise<ApplyResult> {
    this.calls.push(deltas)
    return { applied: 1, tombstoned: 0, conflicts: 0, verdicts: [] }
  }
}

describe('deploy checks sync', () => {
  it('AC-8: a tick written on one service appears in the sync push payload', async () => {
    const sink = new RecordingSink()
    const wrapped = wrapWithSyncWriteThrough(svc, sink)
    await wrapped.setDeployCheck({ goalTaskId: 'TASK-10', env: 'qc', itemKey: 'migration:x', done: true, doneBy: 'butter' })
    const delta = sink.calls.flat().find((d) => d.table === 'deploy_checks')
    expect(delta?.rows[0]).toMatchObject({
      id: 'TASK-10:qc:migration:x',
      goal_task_id: 'TASK-10',
      env: 'qc',
      item_key: 'migration:x',
      done_by: 'butter',
      sync_origin: 'laptop',
      sync_deleted_at: null
    })
  })

  it('the un-tick is pushed with sync_deleted_at set, and applies on another database', async () => {
    const sink = new RecordingSink()
    const wrapped = wrapWithSyncWriteThrough(svc, sink)
    await wrapped.setDeployCheck({ goalTaskId: 'TASK-10', env: 'qc', itemKey: 'k', done: true, doneBy: 'butter' })
    await wrapped.setDeployCheck({ goalTaskId: 'TASK-10', env: 'qc', itemKey: 'k', done: false, doneBy: 'butter' })
    const rows = sink.calls.flat().filter((d) => d.table === 'deploy_checks').map((d) => d.rows[0])
    expect(rows[1].sync_deleted_at).not.toBeNull()

    const other = new SqliteTaskService(path.join(tmp, 'other.db'))
    try {
      applyDeltaToSqlite(other.syncDatabase, [{ table: 'deploy_checks', rows: [rows[0]] }], 'laptop')
      expect(Object.keys((await other.listDeployChecks('TASK-10')).qc)).toEqual(['k'])
      applyDeltaToSqlite(other.syncDatabase, [{ table: 'deploy_checks', rows: [rows[1]] }], 'laptop')
      expect((await other.listDeployChecks('TASK-10')).qc).toEqual({})
    } finally {
      await other.close()
    }
  })
})
