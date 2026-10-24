// TASK-2735 — POST /assistant/chats/:id/messages and its tool loop, against a
// scripted provider. No real model is called: fetchImpl records every request
// and answers with whatever the test scripted.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import Database from 'better-sqlite3'
import { initSchema } from '../../core/domain/repositories/schema'
import { AssistantStore } from './assistant-store'
import { createAssistantTools, type AssistantReadServices } from './assistant-tools'
import { handleAssistantMessageRoute } from './assistant-chat'

const TOKEN = 'assistant-chat-token'
const ENDPOINT = 'https://fixture-resource.openai.azure.com/openai/v1'

interface Sent {
  raw: string
  body: {
    model: string
    tool_choice: string
    max_tokens?: number
    max_completion_tokens?: number
    messages: { role: string; content: string | null; tool_call_id?: string }[]
  }
}

let db: Database.Database
let store: AssistantStore
let tmp: string
let server: Server
let base: string
let sent: Sent[]
let script: (n: number) => Response | Promise<Response>
let toolRuns: number

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

const toolTurn = (args = '{"id":"TASK-1"}', usage: unknown = { prompt_tokens: 10, completion_tokens: 2 }): Response =>
  json(200, {
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          content: null,
          tool_calls: [{ id: `call_${toolRuns}_${Math.random()}`, type: 'function', function: { name: 'get_task', arguments: args } }]
        }
      }
    ],
    usage
  })

const replyTurn = (text: string, usage: unknown = { prompt_tokens: 168, completion_tokens: 19 }): Response =>
  json(200, { choices: [{ finish_reason: 'stop', message: { content: text } }], ...(usage ? { usage } : {}) })

const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
  const raw = String(init?.body ?? '')
  sent.push({ raw, body: JSON.parse(raw) as Sent['body'] })
  return script(sent.length)
}) as unknown as typeof fetch

/** get_task answers with an address in it, so redaction is visible. */
const read = {
  getTask: async () => {
    toolRuns++
    return { id: 'TASK-1', status: 'READY', note: 'host 10.20.30.40' }
  }
} as unknown as AssistantReadServices

async function post(chatId: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/assistant/chats/${chatId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-choda-bridge-token': TOKEN },
    body: JSON.stringify(body)
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

beforeEach(async () => {
  db = new Database(':memory:')
  initSchema(db)
  store = new AssistantStore(db)
  sent = []
  toolRuns = 0
  script = () => replyTurn('done')
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-chat-'))
  fs.writeFileSync(path.join(tmp, 'ai-key.txt'), 'FIXTURE-KEY')
  fs.writeFileSync(
    path.join(tmp, 'ai-provider.json'),
    JSON.stringify({ provider: 'azure', endpoint: ENDPOINT, deployment: 'gpt-5.6-luna' })
  )
  const busy = new Set<string>()
  server = createServer((req, res) => {
    void handleAssistantMessageRoute(req, res, {
      bridgeToken: TOKEN,
      store,
      dataDir: tmp,
      fetchImpl,
      busy,
      tools: () => createAssistantTools(read)
    }).then((handled) => {
      if (!handled) {
        res.writeHead(404)
        res.end('{}')
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('gates before any provider call', () => {
  it('answers 409 budget exhausted for a chat at its budget, with zero provider calls', async () => {
    const chat = store.createChat({ tokenBudget: 200000 })
    store.addTokens(chat.id, 200000)
    const r = await post(chat.id, { content: 'hi' })
    expect(r.status).toBe(409)
    expect(r.json.error).toBe('budget exhausted')
    expect(sent).toHaveLength(0)
  })

  it("answers 409 {error:'busy'} to a second message while the first is still running", async () => {
    const chat = store.createChat({})
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    script = async () => {
      await gate
      return replyTurn('first')
    }
    const first = post(chat.id, { content: 'one' })
    await new Promise((r) => setTimeout(r, 50))
    const second = await post(chat.id, { content: 'two' })
    release()
    expect(second.status).toBe(409)
    expect(second.json).toEqual({ error: 'busy' })
    expect((await first).status).toBe(200)
  })

  it("returns 400 {error:'empty content'} for {content:''} with zero provider calls", async () => {
    const chat = store.createChat({})
    const r = await post(chat.id, { content: '' })
    expect(r.status).toBe(400)
    expect(r.json).toEqual({ error: 'empty content' })
    expect(sent).toHaveLength(0)
  })
})

describe('the tool loop', () => {
  it('executes exactly 8 tools for a provider that asks for a tool on every turn', async () => {
    script = (n) => (n <= 20 && sent[n - 1].body.tool_choice === 'auto' ? toolTurn() : replyTurn('capped answer'))
    const chat = store.createChat({})
    const r = await post(chat.id, { content: 'loop' })
    expect(r.status).toBe(200)
    expect(toolRuns).toBe(8)
    expect((r.json.steps as unknown[]).length).toBe(8)
  })

  it("sends tool_choice 'none' after the 8th tool and marks the reply capped", async () => {
    script = (n) => (sent[n - 1].body.tool_choice === 'auto' ? toolTurn() : replyTurn('capped answer'))
    const chat = store.createChat({})
    const r = await post(chat.id, { content: 'loop' })
    expect(sent).toHaveLength(9)
    expect(sent.slice(0, 8).every((s) => s.body.tool_choice === 'auto')).toBe(true)
    expect(sent[8].body.tool_choice).toBe('none')
    expect(r.json.capped).toBe(true)
  })

  it('sends a tool result containing 10.20.30.40 to the provider as [ip] and stores [ip]', async () => {
    script = (n) => (n === 1 ? toolTurn() : replyTurn('ok'))
    const chat = store.createChat({})
    await post(chat.id, { content: 'status?' })
    const toolMsg = sent[1].body.messages.find((m) => m.role === 'tool')
    expect(toolMsg?.content).toContain('[ip]')
    expect(toolMsg?.content).not.toContain('10.20.30.40')
    const stored = store.listMessages(chat.id).find((m) => m.role === 'tool')
    expect(stored?.content).toContain('[ip]')
    expect(stored?.content).not.toContain('10.20.30.40')
  })

  it('answers unparseable tool arguments with {"error":"invalid arguments"} and calls the provider again', async () => {
    script = (n) => (n === 1 ? toolTurn('not json') : replyTurn('ok'))
    const chat = store.createChat({})
    await post(chat.id, { content: 'x' })
    expect(sent).toHaveLength(2)
    expect(sent[1].body.messages.find((m) => m.role === 'tool')?.content).toBe('{"error":"invalid arguments"}')
    expect(toolRuns).toBe(0)
  })

  it('runs the tool of a content-null tool_calls turn and stores no assistant row with empty text', async () => {
    script = (n) => (n === 1 ? toolTurn() : replyTurn('the answer'))
    const chat = store.createChat({})
    await post(chat.id, { content: 'x' })
    expect(toolRuns).toBe(1)
    const assistantRows = store.listMessages(chat.id).filter((m) => m.role === 'assistant')
    expect(assistantRows.map((m) => m.content)).toEqual(['the answer'])
  })
})

describe('tokens', () => {
  it('adds 187 for usage {prompt_tokens:168, completion_tokens:19} with tokens_estimated 0', async () => {
    script = () => replyTurn('hello', { prompt_tokens: 168, completion_tokens: 19 })
    const chat = store.createChat({})
    await post(chat.id, { content: 'hi' })
    expect(store.getChat(chat.id)?.tokensUsed).toBe(187)
    const last = store.listMessages(chat.id).filter((m) => m.role === 'assistant')[0]
    expect(last.tokensEstimated).toBe(false)
  })

  it('adds ceil(chars/4) and stores tokens_estimated 1 when the response has no usage', async () => {
    script = () => replyTurn('hello', null)
    const chat = store.createChat({})
    await post(chat.id, { content: 'hi' })
    const message = { content: 'hello' }
    const expected = Math.ceil((sent[0].raw.length + JSON.stringify(message).length) / 4)
    expect(store.getChat(chat.id)?.tokensUsed).toBe(expected)
    const last = store.listMessages(chat.id).filter((m) => m.role === 'assistant')[0]
    expect(last.tokensEstimated).toBe(true)
  })
})

describe('provider failures', () => {
  it("returns 502 {kind:'rate_limit'} after exactly one provider call on a 429", async () => {
    script = () => json(429, { error: { message: 'slow down' } }, { 'retry-after': '7' })
    const chat = store.createChat({})
    const r = await post(chat.id, { content: 'x' })
    expect(r.status).toBe(502)
    expect(r.json.kind).toBe('rate_limit')
    expect(sent).toHaveLength(1)
  })

  it('never forwards the provider error body', async () => {
    script = () => json(500, { error: { message: 'SECRET-ECHO api-key=abc' } })
    const chat = store.createChat({})
    const res = await fetch(`${base}/assistant/chats/${chat.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-choda-bridge-token': TOKEN },
      body: JSON.stringify({ content: 'x' })
    })
    const text = await res.text()
    expect(res.status).toBe(502)
    expect(text).not.toContain('SECRET-ECHO')
  })

  it('sends max_completion_tokens and no max_tokens for gpt-5.6-luna', async () => {
    const chat = store.createChat({})
    await post(chat.id, { content: 'x' })
    expect(sent[0].body.model).toBe('gpt-5.6-luna')
    expect(sent[0].body.max_completion_tokens).toBeGreaterThan(0)
    expect('max_tokens' in sent[0].body).toBe(false)
  })
})
