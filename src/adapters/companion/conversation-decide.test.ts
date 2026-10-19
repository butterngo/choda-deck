// TASK-2541 — POST /conversations/:id/decide over real HTTP and a real SQLite
// service. The detail route is mounted too, so state is read back the way the
// companion reads it, not from the service directly.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { SqliteTaskService } from '../../core/domain/sqlite-task-service'
import { handleConversationDecideRoute } from './conversation-decide'
import { handleConversationDetailRoute } from './conversation-detail'

const TOKEN = 'decide-token'
let tmp: string
let svc: SqliteTaskService
let server: Server
let base: string
let convId: string

interface Detail {
  conversation: { status: string; decisionSummary: string | null }
  messages: { kind: string; content: string; authorName: string }[]
}

async function open(participants: string[]): Promise<string> {
  const conv = await svc.openConversation({
    projectId: 'p',
    title: 'Ship or wait',
    createdBy: 'Butter',
    participants: participants.map((name) => ({ name })),
    initialMessage: { content: 'Ship today?' }
  })
  return conv.id
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'decide-'))
  svc = new SqliteTaskService(path.join(tmp, 'test.db'))
  await svc.ensureProject('p', 'P', tmp)
  convId = await open(['Butter', 'Claude'])
  server = createServer((req, res) => {
    void (async () => {
      if (await handleConversationDecideRoute(req, res, { bridgeToken: TOKEN, svc })) return
      if (await handleConversationDetailRoute(req, res, svc)) return
      res.writeHead(418)
      res.end()
    })()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  await svc.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

function decide(id: string, body: unknown, token: string | null = TOKEN): Promise<Response> {
  return fetch(`${base}/conversations/${encodeURIComponent(id)}/decide`, {
    method: 'POST',
    headers: token === null ? {} : { 'x-choda-bridge-token': token },
    body: JSON.stringify(body)
  })
}

async function detail(id: string): Promise<Detail> {
  return (await (await fetch(`${base}/conversations/${encodeURIComponent(id)}`)).json()) as Detail
}

describe('POST /conversations/:id/decide', () => {
  it('AC-1: records the decision; a two-participant thread stays open until both sign off', async () => {
    const res = await decide(convId, { decision: ' ship it ' })
    expect(res.status).toBe(200)
    const { conversation } = (await res.json()) as Detail
    expect(conversation.decisionSummary).toBe('ship it')
    expect(conversation.status).toBe('open')
  })

  it('AC-2: GET /conversations/:id lists the decision turn, authored by companion', async () => {
    await decide(convId, { decision: 'ship it' })
    const turn = (await detail(convId)).messages.find((m) => m.kind === 'decision')
    expect(turn).toMatchObject({ content: 'ship it', authorName: 'companion' })
  })

  it('AC-3: a given author is recorded on the decision turn', async () => {
    await decide(convId, { decision: 'ship it', author: 'Butter' })
    const turn = (await detail(convId)).messages.find((m) => m.kind === 'decision')
    expect(turn?.authorName).toBe('Butter')
  })

  it('AC-4: a thread whose only participant has signed off folds to decided', async () => {
    const solo = await open(['Butter'])
    await svc.signoffConversation(solo, 'Butter')
    const res = await decide(solo, { decision: 'ship it' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as Detail).conversation.status).toBe('decided')
  })

  it('AC-5: a blank decision answers 400 and records nothing', async () => {
    const res = await decide(convId, { decision: '  ' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'decision is required' })
    expect((await detail(convId)).conversation.decisionSummary).toBeNull()
  })

  it('AC-6: an unknown id answers 404', async () => {
    const res = await decide('CONV-404', { decision: 'x' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'unknown conversation: CONV-404' })
  })

  it('AC-7: no bridge token answers 401 and records nothing', async () => {
    expect((await decide(convId, { decision: 'ship it' }, null)).status).toBe(401)
    expect((await detail(convId)).conversation.decisionSummary).toBeNull()
  })

  it('AC-8: a GET on the decide path answers 405', async () => {
    const res = await fetch(`${base}/conversations/${encodeURIComponent(convId)}/decide`)
    expect(res.status).toBe(405)
  })
})
