// TASK-2536 — POST /tasks/translate over real HTTP and a real SQLite service,
// with the provider replaced by a recording fetch. Whether the Vietnamese is any
// GOOD is a human read on a real task; these tests prove the plumbing: the cache,
// the code-span guard, the status mapping and the one-call-per-click bound.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createHash } from 'crypto'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { SqliteTaskService } from '../../core/domain/sqlite-task-service'
import { handleTaskTranslateRoute, mangledReason } from './task-translate'

const TOKEN = 'translate-token'
const ENDPOINT = 'https://fixture-resource.openai.azure.com/openai/v1'
const TITLE = 'Emit events to the platform'
const BODY = ['## Context', 'Write the row in `src/a.ts`.', '', '## Acceptance', '- [ ] `GET /x` answers 200', ''].join('\n')
const VI_TITLE = 'Phát sự kiện lên platform'
const VI_BODY = ['## Bối cảnh', 'Ghi dòng trong `src/a.ts`.', '', '## Tiêu chí', '- [ ] `GET /x` trả 200', ''].join('\n')

let tmp: string
let svc: SqliteTaskService
let server: Server
let base: string
let calls = 0
let reply: () => Response

const fetchImpl = (() => {
  calls++
  return Promise.resolve(reply())
}) as unknown as typeof fetch

const answer = (title: string, body: string): Response =>
  new Response(
    JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ title, body }), refusal: null } }]
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )

function configureProvider(): void {
  fs.writeFileSync(path.join(tmp, 'ai-key.txt'), 'FIXTURE-KEY')
  fs.writeFileSync(
    path.join(tmp, 'ai-provider.json'),
    JSON.stringify({ provider: 'azure', endpoint: ENDPOINT, deployment: 'gpt-4.1-mini' })
  )
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'translate-'))
  svc = new SqliteTaskService(path.join(tmp, 'test.db'))
  await svc.ensureProject('p', 'P', tmp)
  await svc.createTask({ id: 'TASK-1', projectId: 'p', title: TITLE, body: BODY })
  calls = 0
  reply = () => answer(VI_TITLE, VI_BODY)
  server = createServer((req, res) => {
    handleTaskTranslateRoute(req, res, { bridgeToken: TOKEN, svc, dataDir: tmp, fetchImpl }).then((handled) => {
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

async function translate(
  body: unknown = { taskId: 'TASK-1' },
  init: { method?: string; token?: string } = {}
): Promise<{ status: number; json: Record<string, unknown> }> {
  const method = init.method ?? 'POST'
  const res = await fetch(`${base}/tasks/translate`, {
    method,
    headers: init.token === '' ? {} : { 'x-choda-bridge-token': init.token ?? TOKEN },
    body: method === 'GET' ? undefined : JSON.stringify(body)
  })
  const text = await res.text()
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} }
}

describe('POST /tasks/translate', () => {
  it('AC-1: answers 200 with the translation, cached false and the source hash', async () => {
    configureProvider()
    const r = await translate()
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ taskId: 'TASK-1', title: VI_TITLE, body: VI_BODY, cached: false, model: 'gpt-4.1-mini' })
    expect(r.json.sourceHash).toBe(createHash('sha256').update(`${TITLE}\n${BODY}`, 'utf8').digest('hex'))
  })

  it('AC-2: a second identical request is served from cache with no provider call', async () => {
    configureProvider()
    await translate()
    const r = await translate()
    expect(r.status).toBe(200)
    expect(r.json.cached).toBe(true)
    expect(r.json.title).toBe(VI_TITLE)
    expect(calls).toBe(1)
  })

  it('AC-3: an edited body is a new hash, so a second provider call', async () => {
    configureProvider()
    await translate()
    await svc.updateTask('TASK-1', { body: `${BODY}\nOne more line.` })
    const r = await translate()
    expect(r.json.cached).toBe(false)
    expect(calls).toBe(2)
  })

  it('AC-4/AC-5: a body that drops a code span is refused as mangled and not cached', async () => {
    configureProvider()
    reply = () => answer(VI_TITLE, VI_BODY.replace('`src/a.ts`', 'tệp a'))
    const r = await translate()
    expect(r.status).toBe(502)
    expect(r.json).toEqual({ error: 'translation dropped code', kind: 'mangled' })
    await translate()
    expect(calls).toBe(2)
  })

  it('AC-6: a body with one heading fewer is refused as mangled', async () => {
    configureProvider()
    reply = () => answer(VI_TITLE, VI_BODY.replace('## Tiêu chí\n', ''))
    const r = await translate()
    expect(r.status).toBe(502)
    expect(r.json.kind).toBe('mangled')
  })

  it('AC-7: the task keeps its English title and body', async () => {
    configureProvider()
    await translate()
    const task = await svc.getTask('TASK-1')
    expect(task?.title).toBe(TITLE)
    expect(task?.body).toBe(BODY)
  })

  it('AC-8: without ai-provider.json the route answers 501 and calls nothing', async () => {
    const r = await translate()
    expect(r.status).toBe(501)
    expect(r.json).toEqual({ error: 'no model configured' })
    expect(calls).toBe(0)
  })

  it('AC-9: an unknown id answers 404', async () => {
    configureProvider()
    const r = await translate({ taskId: 'TASK-404' })
    expect(r.status).toBe(404)
    expect(r.json).toEqual({ error: 'unknown task: TASK-404' })
  })

  it('AC-10: a body without taskId answers 400', async () => {
    expect((await translate({})).status).toBe(400)
  })

  it('AC-11: a GET answers 405', async () => {
    expect((await translate(undefined, { method: 'GET' })).status).toBe(405)
  })

  it('AC-12: a request without the bridge token answers 401', async () => {
    configureProvider()
    expect((await translate(undefined, { token: '' })).status).toBe(401)
    expect(calls).toBe(0)
  })

  it('AC-13: a provider 429 answers 429 after exactly one call (no retry)', async () => {
    configureProvider()
    reply = () => new Response('slow down', { status: 429, headers: { 'retry-after': '7' } })
    const r = await translate()
    expect(r.status).toBe(429)
    expect(r.json).toEqual({ error: 'rate limited', kind: 'rate_limit' })
    expect(calls).toBe(1)
  })
})

describe('mangledReason', () => {
  it('accepts a translation that keeps fenced and inline code', () => {
    const src = '## A\nUse `x`.\n```\nrun()\n```\n'
    expect(mangledReason(src, '## Á\nDùng `x`.\n```\nrun()\n```\n')).toBeNull()
  })

  it('names a dropped fenced block', () => {
    expect(mangledReason('## A\n```\nrun()\n```\n', '## Á\nchạy\n')).toMatch(/dropped/)
  })
})
