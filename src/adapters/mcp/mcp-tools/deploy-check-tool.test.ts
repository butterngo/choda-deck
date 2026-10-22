// TASK-2606 — deploy_check and deploy_checks_list over a real SQLite service;
// the last case reads the tool's tick back through the companion route.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { SqliteTaskService } from '../../../core/domain/sqlite-task-service'
import { handleDeployChecksRoute } from '../../companion/deploy-checks'
import type { InstrumentedServer } from '../instrumented-server'
import { register } from './deploy-check-tool'

let tmp: string
let svc: SqliteTaskService
const tools = new Map<string, (args: unknown) => Promise<unknown>>()

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-check-tool-'))
  svc = new SqliteTaskService(path.join(tmp, 'test.db'))
  await svc.ensureProject('p', 'P', tmp)
  await svc.createTask({ id: 'TASK-10', projectId: 'p', title: 'Goal', status: 'READY' })
  tools.clear()
  const server = {
    registerTool: (name: string, _c: unknown, fn: (args: unknown) => Promise<unknown>) => {
      tools.set(name, fn)
    },
    registeredToolNames: []
  } as unknown as InstrumentedServer
  register(server, svc)
})

afterEach(async () => {
  await svc.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

async function call(name: string, args: unknown): Promise<Record<string, unknown>> {
  const out = (await tools.get(name)!(args)) as { content: { text: string }[] }
  return JSON.parse(out.content[0].text) as Record<string, unknown>
}

type Checks = Record<'qc' | 'prod', Record<string, { doneBy: string; doneAt: string; note: string | null }>>

const RECORD = 'insfrastrucure/ichiba/docs/deploys/2026-10-21-bpa-engine-qc-task2513.md'

describe('deploy_check tool', () => {
  it('AC-1: a prod tick is listed with doneBy claude', async () => {
    const res = await call('deploy_check', { goalTaskId: 'TASK-10', env: 'prod', itemKey: 'migration:x', done: true })
    expect(res).toMatchObject({ goalTaskId: 'TASK-10', env: 'prod', itemKey: 'migration:x', done: true, doneBy: 'claude' })
    const list = (await call('deploy_checks_list', { goalTaskId: 'TASK-10' })) as unknown as Checks
    expect(list.prod['migration:x'].doneBy).toBe('claude')
  })

  it('AC-2: the note given is returned by deploy_checks_list', async () => {
    await call('deploy_check', { goalTaskId: 'TASK-10', env: 'qc', itemKey: 'sql:a.sql', done: true, note: RECORD })
    const list = (await call('deploy_checks_list', { goalTaskId: 'TASK-10' })) as unknown as Checks
    expect(list.qc['sql:a.sql'].note).toBe(RECORD)
  })

  it('AC-3: an unknown goal answers UNKNOWN_GOAL', async () => {
    expect(await call('deploy_check', { goalTaskId: 'TASK-999', env: 'qc', itemKey: 'x', done: true })).toMatchObject({ error: 'UNKNOWN_GOAL' })
    expect(await call('deploy_checks_list', { goalTaskId: 'TASK-999' })).toMatchObject({ error: 'UNKNOWN_GOAL' })
  })

  it('AC-4: env dev answers BAD_ENV and writes nothing', async () => {
    expect(await call('deploy_check', { goalTaskId: 'TASK-10', env: 'dev', itemKey: 'x', done: true })).toMatchObject({ error: 'BAD_ENV' })
    expect(await call('deploy_checks_list', { goalTaskId: 'TASK-10' })).toEqual({ qc: {}, prod: {} })
  })

  it('AC-5: a tick written by the tool is returned by GET /runs/<goal>/deploy-checks on the same database', async () => {
    await call('deploy_check', { goalTaskId: 'TASK-10', env: 'qc', itemKey: 'migration:x', done: true, note: RECORD })
    const server: Server = createServer((req, res) => {
      void handleDeployChecksRoute(req, res, { svc, bridgeToken: 'tok' })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    try {
      const port = (server.address() as AddressInfo).port
      const res = await fetch(`http://127.0.0.1:${port}/runs/TASK-10/deploy-checks`, { headers: { 'x-choda-bridge-token': 'tok' } })
      const body = (await res.json()) as Checks
      expect(body.qc['migration:x']).toMatchObject({ doneBy: 'claude', note: RECORD })
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})
