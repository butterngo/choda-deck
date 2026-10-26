// TASK-2758 — the adapter spawns the assistant service and forwards /assistant/*.
// A fake child script stands in for assistant-server.cjs: it prints the same
// listening line, echoes what it was started with, streams on demand, and
// records when a client went away. One test per acceptance criterion.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { startCompanionServer, COMPANION_BIND, type CompanionServerHandle } from './http-server'
import type { CompanionServices } from './service-factory'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'
import { AssistantChild } from './assistant-child'

const TOKEN = 'child-token'

const FAKE = `
const http = require('http')
const fs = require('fs')
const delay = Number(process.env.FAKE_LISTEN_DELAY_MS || 0)
const server = http.createServer((req, res) => {
  if (req.url === '/assistant/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('event: delta\\ndata: {"text":"Hel"}\\n\\n')
    req.on('close', () => { if (!res.writableEnded) fs.writeFileSync(process.env.FAKE_MARK, 'closed') })
    setTimeout(() => { if (!res.destroyed) res.end('event: done\\ndata: {}\\n\\n') }, 500)
    return
  }
  res.writeHead(201, { 'content-type': 'application/json' })
  res.end(JSON.stringify({
    from: 'fake',
    url: req.url,
    env: {
      port: process.env.CHODA_ASSISTANT_PORT,
      token: process.env.CHODA_BRIDGE_TOKEN,
      adapter: process.env.CHODA_ADAPTER_URL
    }
  }))
})
server.listen(0, '127.0.0.1', () => {
  setTimeout(() => console.log('[assistant] listening on http://127.0.0.1:' + server.address().port), delay)
})
`

let tmp: string
let fakePath: string
let handle: CompanionServerHandle
let services: CompanionServices
let base: string
let child: AssistantChild | null
let logs: string[]

const fakeSvc = {
  listProjects: async () => [],
  findTasks: async () => [],
  findInbox: async () => [],
  findConversations: async () => [],
  findWorkspaces: async () => []
} as unknown as BackendTaskService

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 20))
  }
}

function makeChild(now?: () => number): AssistantChild {
  child = new AssistantChild({
    entry: fakePath,
    dataDir: tmp,
    bridgeToken: TOKEN,
    adapterPort: handle.address.port,
    execPath: process.execPath,
    log: (l) => logs.push(l),
    now
  })
  services.assistant = child
  return child
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'choda-assistant-child-'))
  fakePath = path.join(tmp, 'fake-assistant.cjs')
  fs.writeFileSync(fakePath, FAKE)
  process.env.FAKE_MARK = path.join(tmp, 'closed.txt')
  delete process.env.FAKE_LISTEN_DELAY_MS
  logs = []
  child = null
  services = {
    svc: fakeSvc,
    db: null,
    dbPath: ':memory:',
    intervalMs: 30000,
    bridgeToken: TOKEN,
    dataDir: tmp,
    pull: async () => ({ upserted: 0, tombstoned: 0, cursor: 0 }),
    push: async () => ({ drained: 0, conflicts: 0, remaining: 0, reachable: true }),
    close: () => {}
  } as unknown as CompanionServices
  handle = await startCompanionServer(services, 0)
  base = `http://${COMPANION_BIND}:${handle.address.port}`
})

afterEach(async () => {
  child?.stop()
  await handle.close()
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    /* temp dir */
  }
})

describe('the adapter forwards /assistant/* to its child', () => {
  it("AC-1: GET /assistant/chats on the adapter returns the child's body and status", async () => {
    const c = makeChild()
    c.start()
    await until(() => c.listeningPort !== null)
    const r = await fetch(`${base}/assistant/chats`, { headers: { 'x-choda-bridge-token': TOKEN } })
    expect(r.status).toBe(201)
    const body = (await r.json()) as { from: string; url: string }
    expect(body.from).toBe('fake')
    expect(body.url).toBe('/assistant/chats')
  })

  it("AC-2: the child is started with port 0, the bridge token and the adapter's own URL", async () => {
    const c = makeChild()
    c.start()
    await until(() => c.listeningPort !== null)
    const r = await fetch(`${base}/assistant/models`)
    const body = (await r.json()) as { env: { port: string; token: string; adapter: string } }
    expect(body.env).toEqual({ port: '0', token: TOKEN, adapter: `http://127.0.0.1:${handle.address.port}` })
  })

  it('AC-3: a streamed reply reaches the client event by event, not buffered', async () => {
    const c = makeChild()
    c.start()
    await until(() => c.listeningPort !== null)
    const t0 = Date.now()
    const r = await fetch(`${base}/assistant/stream`)
    const reader = (r.body as ReadableStream<Uint8Array>).getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    const firstAt = Date.now() - t0
    expect(first).toContain('event: delta')
    expect(firstAt).toBeLessThan(400)
    let rest = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      rest += new TextDecoder().decode(value)
    }
    expect(rest).toContain('event: done')
  })

  it("AC-4: a client hanging up mid-stream closes the child's request", async () => {
    const c = makeChild()
    c.start()
    await until(() => c.listeningPort !== null)
    const ctrl = new AbortController()
    const r = await fetch(`${base}/assistant/stream`, { signal: ctrl.signal })
    const reader = (r.body as ReadableStream<Uint8Array>).getReader()
    await reader.read()
    ctrl.abort()
    await until(() => fs.existsSync(process.env.FAKE_MARK as string))
    expect(fs.readFileSync(process.env.FAKE_MARK as string, 'utf8')).toBe('closed')
  })

  it('AC-5: before the listening line arrives, /assistant/chats answers 503', async () => {
    process.env.FAKE_LISTEN_DELAY_MS = '2000'
    const c = makeChild()
    c.start()
    const r = await fetch(`${base}/assistant/chats`)
    expect(r.status).toBe(503)
    expect(await r.json()).toEqual({ error: 'assistant service unavailable' })
  })

  it('AC-6: after an exit the next request is 503 and one child is respawned; a second exit within 60 s stops it', async () => {
    let clock = 1_000_000
    const c = makeChild(() => clock)
    c.start()
    await until(() => c.listeningPort !== null)
    expect(c.spawns).toBe(1)

    process.kill(c.pid as number)
    await until(() => c.pid === null)
    const r1 = await fetch(`${base}/assistant/chats`)
    expect(r1.status).toBe(503)
    expect(c.spawns).toBe(2)
    await until(() => c.listeningPort !== null)

    clock += 30_000
    process.kill(c.pid as number)
    await until(() => c.pid === null)
    const r2 = await fetch(`${base}/assistant/chats`)
    expect(r2.status).toBe(503)
    await new Promise((r) => setTimeout(r, 300))
    expect(c.spawns).toBe(2)
    expect(logs).toContain('[assistant] stopped after two exits')
  })

  it('without a child at all, /assistant/* answers 503 rather than falling through', async () => {
    const r = await fetch(`${base}/assistant/chats`, { method: 'POST' })
    expect(r.status).toBe(503)
  })
})
