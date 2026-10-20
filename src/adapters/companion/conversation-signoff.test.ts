// TASK-2549 — POST /conversations/:id/signoff over real HTTP and a real SQLite
// service, with the detail route mounted so signoff turns are read back the way
// the companion reads them.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { SqliteTaskService } from '../../core/domain/sqlite-task-service'
import { handleConversationSignoffRoute } from './conversation-signoff'
import { handleConversationDetailRoute } from './conversation-detail'

const TOKEN = 'signoff-token'
let tmp: string
let svc: SqliteTaskService
let server: Server
let base: string
let convId: string

interface SignoffAnswer {
  conversation: { status: string }
  signedOff: string[]
  decided: boolean
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'signoff-'))
  svc = new SqliteTaskService(path.join(tmp, 'test.db'))
  await svc.ensureProject('p', 'P', tmp)
  const conv = await svc.openConversation({
    projectId: 'p',
    title: 'Ship or wait',
    createdBy: 'Butter',
    participants: [{ name: 'Butter' }, { name: 'Claude' }],
    initialMessage: { content: 'Ship today?' }
  })
  convId = conv.id
  server = createServer((req, res) => {
    void (async () => {
      if (await handleConversationSignoffRoute(req, res, { bridgeToken: TOKEN, svc })) return
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

function signoff(id: string, body: unknown, token: string | null = TOKEN): Promise<Response> {
  return fetch(`${base}/conversations/${encodeURIComponent(id)}/signoff`, {
    method: 'POST',
    headers: token === null ? {} : { 'x-choda-bridge-token': token },
    body: JSON.stringify(body)
  })
}

async function signoffTurns(id: string): Promise<{ authorName: string }[]> {
  const detail = (await (await fetch(`${base}/conversations/${encodeURIComponent(id)}`)).json()) as {
    messages: { kind: string; authorName: string }[]
  }
  return detail.messages.filter((m) => m.kind === 'signoff')
}

describe('POST /conversations/:id/signoff', () => {
  it('AC-1: Butter signs; the thread stays open while Claude has not', async () => {
    const res = await signoff(convId, { name: 'Butter' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as SignoffAnswer
    expect(body.signedOff).toEqual(['Butter'])
    expect(body.decided).toBe(false)
    expect(body.conversation.status).toBe('open')
  })

  it('AC-2: the signoff that completes consensus answers decided', async () => {
    // Consensus is a decision plus every participant's signoff (the fold in
    // conversation-repository.ts), so the thread needs its decision first.
    await svc.decideConversation(convId, { author: 'Butter', decision: 'ship it' })
    await svc.signoffConversation(convId, 'Claude')
    const body = (await (await signoff(convId, { name: 'Butter' })).json()) as SignoffAnswer
    expect(body.decided).toBe(true)
    expect(body.conversation.status).toBe('decided')
  })

  it('AC-3: signing twice leaves one signoff turn', async () => {
    await signoff(convId, { name: 'Butter' })
    await signoff(convId, { name: 'Butter' })
    expect((await signoffTurns(convId)).filter((m) => m.authorName === 'Butter')).toHaveLength(1)
  })

  it('AC-4: a non-participant is refused and nothing is recorded', async () => {
    const res = await signoff(convId, { name: 'Mallory' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'not a participant: Mallory' })
    expect(await signoffTurns(convId)).toHaveLength(0)
  })

  it('AC-5: a blank name answers 400', async () => {
    const res = await signoff(convId, { name: '  ' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'name is required' })
  })

  it('AC-6: an unknown id answers 404', async () => {
    const res = await signoff('CONV-404', { name: 'Butter' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'unknown conversation: CONV-404' })
  })

  it('AC-7: no bridge token answers 401 and nothing is recorded', async () => {
    expect((await signoff(convId, { name: 'Butter' }, null)).status).toBe(401)
    expect(await signoffTurns(convId)).toHaveLength(0)
  })

  it('AC-8: a GET on the signoff path answers 405', async () => {
    const res = await fetch(`${base}/conversations/${encodeURIComponent(convId)}/signoff`)
    expect(res.status).toBe(405)
  })
})
