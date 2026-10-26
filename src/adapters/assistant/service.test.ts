// TASK-2755 — the assistant service skeleton: its process boundary, assistant.db,
// the one-time migration from the shared database, and the free chat routes.
// One test per acceptance criterion. No model is called here.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import Database from 'better-sqlite3'
import { startAssistantService, type AssistantServiceHandle } from './server'
import { ChatStore } from './chat-store'

const TOKEN = 'assistant-service-token'
const AUTH = { 'x-choda-bridge-token': TOKEN }

let tmp: string
let sharedDbPath: string
let handle: AssistantServiceHandle | null
let base: string
let logged: string[]

async function start(): Promise<AssistantServiceHandle> {
  logged = []
  const h = await startAssistantService({ dataDir: tmp, sharedDbPath, bridgeToken: TOKEN, log: (l) => logged.push(l) }, 0)
  handle = h
  base = `http://127.0.0.1:${h.port}`
  return h
}

async function stop(): Promise<void> {
  if (handle) await handle.close()
  handle = null
}

function call(
  method: string,
  urlPath: string,
  body?: unknown,
  headers: Record<string, string> = AUTH
): Promise<{ status: number; json: unknown }> {
  return fetch(`${base}${urlPath}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  }).then(async (r) => {
    const text = await r.text()
    return { status: r.status, json: text === '' ? null : JSON.parse(text) }
  })
}

/**
 * Seeds the shared choda-deck.db the way the adapter-era store wrote it
 * (TASK-2733 schema, ids `CHAT-n` / `CHAT-n-Mk`). Written as SQL because that
 * store and its schema are gone from the adapter (TASK-2759); a machine that
 * has not started the service yet still has exactly these rows.
 */
function seedShared(): void {
  fs.mkdirSync(path.dirname(sharedDbPath), { recursive: true })
  const db = new Database(sharedDbPath)
  db.exec(`
    CREATE TABLE assistant_chats (id TEXT PRIMARY KEY, title TEXT NOT NULL, model TEXT,
      token_budget INTEGER NOT NULL DEFAULT 300000, tokens_used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE assistant_messages (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT, tool_name TEXT, tool_call_id TEXT, model TEXT, prompt_tokens INTEGER,
      completion_tokens INTEGER, tokens_estimated INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
  `)
  const at = (s: number): string => new Date(Date.UTC(2026, 9, 24, 8, 0, s)).toISOString()
  const chat = db.prepare('INSERT INTO assistant_chats VALUES (?, ?, NULL, 300000, ?, ?, ?)')
  chat.run('CHAT-1', 'Ichiba servers', 120, at(0), at(5))
  chat.run('CHAT-2', 'Summarise meeting BPA sync', 60, at(1), at(7))
  const msg = db.prepare('INSERT INTO assistant_messages VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, ?)')
  msg.run('CHAT-1-M1', 'CHAT-1', 'user', 'which servers?', null, null, null, null, at(2))
  msg.run('CHAT-1-M2', 'CHAT-1', 'tool', '{"hits":[]}', 'search_vault', 'c1', null, null, at(3))
  msg.run('CHAT-1-M3', 'CHAT-1', 'assistant', 'None found.', null, null, 100, 20, at(4))
  msg.run('CHAT-2-M1', 'CHAT-2', 'user', 'summarise', null, null, null, null, at(6))
  msg.run('CHAT-2-M2', 'CHAT-2', 'assistant', 'Two decisions.', null, null, 50, 10, at(7))
  db.close()
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'choda-assistant-'))
  sharedDbPath = path.join(tmp, 'database', 'choda-deck.db')
  handle = null
})

afterEach(async () => {
  await stop()
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    /* temp dir; the OS reclaims it */
  }
})

describe('process boundary', () => {
  it('AC-1: started on port 0 it prints one listening line and answers on that port', async () => {
    const h = await start()
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatch(/^\[assistant\] listening on http:\/\/127\.0\.0\.1:\d+$/)
    const port = Number(/:(\d+)$/.exec(logged[0])?.[1])
    expect(port).toBe(h.port)
    const r = await fetch(`http://127.0.0.1:${port}/assistant/chats`, { headers: AUTH })
    expect(r.status).toBe(200)
  })

  it('AC-2: a request without x-choda-bridge-token returns 401', async () => {
    await start()
    const r = await call('GET', '/assistant/chats', undefined, {})
    expect(r.status).toBe(401)
  })
})

describe('migration from the shared database', () => {
  it('AC-3: the first start copies both chats with ids, titles, tokensUsed and all 5 messages', async () => {
    seedShared()
    const h = await start()
    expect(h.migrated).toBe(2)
    const list = (await call('GET', '/assistant/chats')).json as { id: string; title: string; tokensUsed: number }[]
    const byId = Object.fromEntries(list.map((c) => [c.id, c]))
    expect(Object.keys(byId).sort()).toEqual(['CHAT-1', 'CHAT-2'])
    expect(byId['CHAT-1'].title).toBe('Ichiba servers')
    expect(byId['CHAT-1'].tokensUsed).toBe(120)
    expect(byId['CHAT-2'].tokensUsed).toBe(60)
    const one = (await call('GET', '/assistant/chats/CHAT-1')).json as { messages: { id: string }[] }
    const two = (await call('GET', '/assistant/chats/CHAT-2')).json as { messages: { id: string }[] }
    expect(one.messages.map((m) => m.id)).toEqual(['CHAT-1-M1', 'CHAT-1-M2', 'CHAT-1-M3'])
    expect(one.messages.length + two.messages.length).toBe(5)
  })

  it('AC-4: a second start over the same files leaves exactly 2 chats and 5 messages', async () => {
    seedShared()
    await start()
    await stop()
    const h = await start()
    expect(h.migrated).toBe(0)
    const list = (await call('GET', '/assistant/chats')).json as { id: string }[]
    expect(list).toHaveLength(2)
    const counts = await Promise.all(
      list.map(async (c) => ((await call('GET', `/assistant/chats/${c.id}`)).json as { messages: unknown[] }).messages.length)
    )
    expect(counts.reduce((a, b) => a + b, 0)).toBe(5)
  })

  it('AC-5: a shared DB with no assistant_chats table starts cleanly with zero chats', async () => {
    fs.mkdirSync(path.dirname(sharedDbPath), { recursive: true })
    const db = new Database(sharedDbPath)
    db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY)')
    db.close()
    const h = await start()
    expect(h.migrated).toBe(0)
    expect((await call('GET', '/assistant/chats')).json).toEqual([])
  })

  it('the migration never writes to the shared database', async () => {
    seedShared()
    const before = fs.readFileSync(sharedDbPath)
    await start()
    await stop()
    expect(fs.readFileSync(sharedDbPath).equals(before)).toBe(true)
  })
})

describe('PATCH /assistant/chats/:id', () => {
  it('AC-6: renames and a following GET shows the title', async () => {
    seedShared()
    await start()
    const r = await call('PATCH', '/assistant/chats/CHAT-1', { title: 'Ichiba servers' })
    expect(r.status).toBe(200)
    await call('PATCH', '/assistant/chats/CHAT-1', { title: 'Ichiba prod servers' })
    const got = (await call('GET', '/assistant/chats/CHAT-1')).json as { chat: { title: string } }
    expect(got.chat.title).toBe('Ichiba prod servers')
  })

  it('AC-7: a blank title returns 400 title is required', async () => {
    seedShared()
    await start()
    const r = await call('PATCH', '/assistant/chats/CHAT-1', { title: '  ' })
    expect(r.status).toBe(400)
    expect(r.json).toEqual({ error: 'title is required' })
  })

  it('AC-8: an unknown chat returns 404 unknown chat', async () => {
    await start()
    const r = await call('PATCH', '/assistant/chats/CHAT-999', { title: 'x' })
    expect(r.status).toBe(404)
    expect(r.json).toEqual({ error: 'unknown chat: CHAT-999' })
  })
})

describe('DELETE /assistant/chats/:id', () => {
  it('AC-9: returns 204 and a following GET returns 404', async () => {
    seedShared()
    await start()
    const r = await call('DELETE', '/assistant/chats/CHAT-1')
    expect(r.status).toBe(204)
    expect((await call('GET', '/assistant/chats/CHAT-1')).status).toBe(404)
  })

  it('AC-10: a chat in the busy set returns 409 busy and still exists', async () => {
    seedShared()
    const h = await start()
    h.busy.add('CHAT-1')
    const r = await call('DELETE', '/assistant/chats/CHAT-1')
    expect(r.status).toBe(409)
    expect(r.json).toEqual({ error: 'busy' })
    expect((await call('GET', '/assistant/chats/CHAT-1')).status).toBe(200)
  })
})

describe('ids never repeat', () => {
  it('AC-11: after deleting the last two of -M1..-M4, the next message is -M5', () => {
    const store = new ChatStore(new Database(':memory:'))
    const chat = store.createChat({})
    for (let i = 0; i < 4; i++) store.appendMessage(chat.id, { role: i % 2 ? 'assistant' : 'user', content: `m${i}` })
    expect(store.listMessages(chat.id).map((m) => m.id)).toEqual([
      `${chat.id}-M1`,
      `${chat.id}-M2`,
      `${chat.id}-M3`,
      `${chat.id}-M4`
    ])
    expect(store.deleteMessagesAfter(chat.id, 2)).toBe(2)
    expect(store.appendMessage(chat.id, { role: 'user', content: 'again' }).id).toBe(`${chat.id}-M5`)
  })

  it('a chat created after deleting the newest one gets a new number', () => {
    const store = new ChatStore(new Database(':memory:'))
    store.createChat({})
    const second = store.createChat({})
    store.deleteChat(second.id)
    expect(store.createChat({}).id).toBe('CHAT-3')
  })
})

describe('GET /assistant/chats?q=', () => {
  it('AC-12: returns only the chat whose message contains the word', async () => {
    await start()
    const store = (handle as AssistantServiceHandle).store
    const a = store.createChat({ title: 'one' })
    const b = store.createChat({ title: 'two' })
    store.appendMessage(a.id, { role: 'user', content: 'a zebra crossing' })
    store.appendMessage(b.id, { role: 'user', content: 'a horse' })
    const r = (await call('GET', '/assistant/chats?q=zebra')).json as { id: string }[]
    expect(r.map((c) => c.id)).toEqual([a.id])
  })
})
