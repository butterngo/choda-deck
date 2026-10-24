// TASK-2733 — the chat assistant's free routes, against an in-memory DB and a
// stubbed deployments listing. No completion is ever requested here.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import Database from 'better-sqlite3'
import { initSchema } from '../../core/domain/repositories/schema'
import { APPLY_TABLES } from '../../core/sync/sync-apply'
import { AssistantStore } from './assistant-store'
import { handleAssistantRoute } from './assistant-routes'

const TOKEN = 'assistant-token'
const ENDPOINT = 'https://fixture-resource.openai.azure.com/openai/v1'
const AUTH = { 'x-choda-bridge-token': TOKEN }

/** A response body, read field by field in each test. */
interface Loose {
  error?: string
  id?: string
  selected?: string
  tokenBudget?: number
  tokensUsed?: number
  models?: { id: string }[]
  chat?: { id: string }
  messages?: { content: string; promptTokens: number | null }[]
  map: <T>(fn: (c: { title: string }) => T) => T[]
}

let db: Database.Database
let store: AssistantStore
let tmp: string
let server: Server
let base: string
let deployments: { id: string; model: string; status: string }[]
let clock: number

/** Stubbed resource: the deployments listing and the model catalog, nothing else. */
const fetchImpl = ((url: RequestInfo | URL) => {
  const u = String(url)
  if (u.includes('/openai/deployments')) {
    return Promise.resolve(new Response(JSON.stringify({ data: deployments }), { status: 200 }))
  }
  if (u.endsWith('/models')) {
    const data = deployments.map((d) => ({ id: d.model, capabilities: { chat_completion: true } }))
    return Promise.resolve(new Response(JSON.stringify({ data }), { status: 200 }))
  }
  throw new Error(`unexpected provider call: ${u}`)
}) as unknown as typeof fetch

function configureProvider(): void {
  fs.writeFileSync(path.join(tmp, 'ai-key.txt'), 'FIXTURE-KEY')
  fs.writeFileSync(
    path.join(tmp, 'ai-provider.json'),
    JSON.stringify({ provider: 'azure', endpoint: ENDPOINT, deployment: 'gpt-4.1-mini' })
  )
}

async function call(
  method: string,
  route: string,
  body?: unknown,
  headers: Record<string, string> = AUTH
): Promise<{ status: number; json: Loose }> {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await res.text()
  return { status: res.status, json: (text ? JSON.parse(text) : null) as Loose }
}

beforeEach(async () => {
  db = new Database(':memory:')
  initSchema(db)
  clock = Date.parse('2026-10-24T00:00:00Z')
  store = new AssistantStore(db, () => new Date((clock += 1000)).toISOString())
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-routes-'))
  deployments = [
    { id: 'gpt-4.1-mini', model: 'gpt-4.1-mini', status: 'succeeded' },
    { id: 'gpt-5.6-luna', model: 'gpt-5.6-luna', status: 'succeeded' }
  ]
  configureProvider()
  server = createServer((req, res) => {
    void handleAssistantRoute(req, res, { bridgeToken: TOKEN, store, dataDir: tmp, fetchImpl }).then(
      (handled) => {
        if (!handled) {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'not found' }))
        }
      }
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('GET /assistant/models', () => {
  it('returns 401 without x-choda-bridge-token', async () => {
    const r = await call('GET', '/assistant/models', undefined, {})
    expect(r.status).toBe(401)
  })

  it("selects 'gpt-5.6-luna' when the listing contains that deployment", async () => {
    const r = await call('GET', '/assistant/models')
    expect(r.status).toBe(200)
    expect(r.json.selected).toBe('gpt-5.6-luna')
    expect(r.json.models?.map((m) => m.id)).toEqual(['gpt-4.1-mini', 'gpt-5.6-luna'])
  })

  it('selects the configured default when the listing lacks gpt-5.6-luna', async () => {
    deployments = [{ id: 'gpt-4.1-mini', model: 'gpt-4.1-mini', status: 'succeeded' }]
    const r = await call('GET', '/assistant/models')
    expect(r.status).toBe(200)
    expect(r.json.selected).toBe('gpt-4.1-mini')
  })

  it('returns 501 when no model is configured', async () => {
    fs.rmSync(path.join(tmp, 'ai-provider.json'))
    const r = await call('GET', '/assistant/models')
    expect(r.status).toBe(501)
    expect(r.json).toEqual({ error: 'no model configured' })
  })
})

describe('POST /assistant/chats', () => {
  it('returns 400 for tokenBudget 500000 and creates no row', async () => {
    const r = await call('POST', '/assistant/chats', { tokenBudget: 500000 })
    expect(r.status).toBe(400)
    expect(r.json).toEqual({ error: 'tokenBudget must be 200000-400000' })
    expect((db.prepare('SELECT COUNT(*) AS n FROM assistant_chats').get() as { n: number }).n).toBe(0)
  })

  it('creates a chat with tokenBudget 300000 and tokensUsed 0 when the body has no fields', async () => {
    const r = await call('POST', '/assistant/chats', {})
    expect(r.status).toBe(201)
    expect(r.json.id).toBe('CHAT-1')
    expect(r.json.tokenBudget).toBe(300000)
    expect(r.json.tokensUsed).toBe(0)
  })

  it('returns 400 for a body that is not JSON', async () => {
    const res = await fetch(`${base}/assistant/chats`, { method: 'POST', headers: AUTH, body: '{nope' })
    expect(res.status).toBe(400)
  })
})

describe('GET /assistant/chats', () => {
  it('lists two chats with the most recently updated first', async () => {
    const first = store.createChat({ title: 'first' })
    store.createChat({ title: 'second' })
    store.appendMessage(first.id, { role: 'user', content: 'touch first again' })
    const r = await call('GET', '/assistant/chats')
    expect(r.status).toBe(200)
    expect(r.json.map((c) => c.title)).toEqual(['first', 'second'])
  })
})

describe('GET /assistant/chats/:id', () => {
  it("returns 404 {error:'unknown chat: CHAT-999'} for a chat that does not exist", async () => {
    const r = await call('GET', '/assistant/chats/CHAT-999')
    expect(r.status).toBe(404)
    expect(r.json).toEqual({ error: 'unknown chat: CHAT-999' })
  })

  it('returns the chat and its messages oldest first', async () => {
    const chat = store.createChat({ title: 't' })
    store.appendMessage(chat.id, { role: 'user', content: 'q' })
    store.appendMessage(chat.id, { role: 'assistant', content: 'a', promptTokens: 168, completionTokens: 19 })
    const r = await call('GET', `/assistant/chats/${chat.id}`)
    expect(r.status).toBe(200)
    expect(r.json.chat?.id).toBe(chat.id)
    expect(r.json.messages?.map((m) => m.content)).toEqual(['q', 'a'])
    expect(r.json.messages?.[1]?.promptTokens).toBe(168)
  })
})

describe('local only', () => {
  it('keeps assistant_chats and assistant_messages out of the sync allowlist', () => {
    expect(APPLY_TABLES).not.toContain('assistant_chats')
    expect(APPLY_TABLES).not.toContain('assistant_messages')
  })
})
