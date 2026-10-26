// TASK-2756 — the service's tools read work data over the adapter's HTTP routes.
// A local stub stands in for the adapter and records every request it gets, so
// "what was asked of the adapter" is asserted, not inferred from the answer.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { createAdapterReads } from './adapter-reads'
import { createAssistantTools } from './tools'

const TOKEN = 'tools-token'

interface Seen {
  method: string
  url: string
  token: string | undefined
}

let server: Server
let base: string
let seen: Seen[]
/** Per-test answer: status + JSON body, keyed by path prefix. */
let answer: (url: string) => { status: number; body: unknown } | 'hang'

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({
      method: req.method ?? '',
      url: req.url ?? '',
      token: req.headers['x-choda-bridge-token'] as string | undefined
    })
    const a = answer(req.url ?? '')
    if (a === 'hang') return
    res.writeHead(a.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(a.body))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((r) => server.close(() => r()))
})

beforeEach(() => {
  seen = []
  answer = () => ({ status: 200, body: {} })
})

function tools(url = base, timeoutMs?: number) {
  return createAssistantTools(createAdapterReads({ adapterUrl: url, bridgeToken: TOKEN, store: null, timeoutMs }))
}

describe('tools over the adapter', () => {
  it('AC-1: get_task sends GET /tasks/TASK-12 with the bridge token and returns its status', async () => {
    answer = (u) => (u === '/tasks/TASK-12' ? { status: 200, body: { id: 'TASK-12', status: 'READY' } } : { status: 404, body: {} })
    const out = JSON.parse(await tools().execute('get_task', '{"id":"TASK-12"}'))
    expect(seen).toEqual([{ method: 'GET', url: '/tasks/TASK-12', token: TOKEN }])
    expect(out.status).toBe('READY')
  })

  it('AC-2: nothing listening on the adapter URL gives adapter unavailable, without throwing', async () => {
    const dead = createServer()
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', () => r()))
    const port = (dead.address() as AddressInfo).port
    await new Promise<void>((r) => dead.close(() => r()))
    const out = await tools(`http://127.0.0.1:${port}`).execute('get_task', '{"id":"TASK-12"}')
    expect(JSON.parse(out)).toEqual({ error: 'adapter unavailable' })
  })

  it('an adapter that does not answer within the timeout gives adapter unavailable', async () => {
    answer = () => 'hang'
    const out = await tools(base, 200).execute('get_task', '{"id":"TASK-12"}')
    expect(JSON.parse(out)).toEqual({ error: 'adapter unavailable' })
  })

  it('AC-3: a 500 from the adapter gives adapter unavailable', async () => {
    answer = () => ({ status: 500, body: { error: 'internal error' } })
    const out = await tools().execute('get_task', '{"id":"TASK-12"}')
    expect(JSON.parse(out)).toEqual({ error: 'adapter unavailable' })
  })

  it("AC-4: a 404 carries the adapter's own error text", async () => {
    answer = () => ({ status: 404, body: { error: 'unknown task: TASK-9' } })
    const out = await tools().execute('get_task', '{"id":"TASK-9"}')
    expect(JSON.parse(out)).toEqual({ error: 'unknown task: TASK-9' })
  })

  it('AC-5: read_vault_note on 20-Areas is refused with zero requests to the adapter', async () => {
    const out = await tools().execute('read_vault_note', '{"path":"20-Areas/goals.md"}')
    expect(JSON.parse(out)).toEqual({ error: 'path not readable' })
    expect(seen).toHaveLength(0)
  })

  it('read_vault_note on a project note asks GET /vault/note?path=', async () => {
    answer = () => ({ status: 200, body: 'ignored' })
    await tools().execute('read_vault_note', '{"path":"10-Projects/ichiba-devops/context.md"}')
    expect(seen.map((s) => s.url)).toEqual(['/vault/note?path=10-Projects%2Fichiba-devops%2Fcontext.md'])
  })

  it('AC-6: search_vault sends GET /vault/search?q=ichiba', async () => {
    answer = () => ({ status: 200, body: [] })
    await tools().execute('search_vault', '{"query":"ichiba"}')
    expect(seen).toHaveLength(1)
    const u = new URL(seen[0].url, 'http://x')
    expect(u.pathname).toBe('/vault/search')
    expect(u.searchParams.get('q')).toBe('ichiba')
  })

  it('AC-7: a task body holding an IPv4 address comes back with [ip]', async () => {
    answer = () => ({ status: 200, body: { id: 'TASK-1', status: 'READY', body: 'host 10.20.30.40 ok' } })
    const out = await tools().execute('get_task', '{"id":"TASK-1"}')
    expect(out).toContain('host [ip] ok')
    expect(out).not.toContain('10.20.30.40')
  })

  it('AC-8: the registry has exactly 15 tools, each description at most 1024 characters', () => {
    const defs = tools().definitions
    expect(defs).toHaveLength(15)
    for (const d of defs) expect(d.function.description.length).toBeLessThanOrEqual(1024)
  })

  it('AC-9: every tool that reaches the adapter does so with GET', async () => {
    answer = (u) => {
      if (u.startsWith('/tasks?')) return { status: 200, body: { tasks: [] } }
      if (u.startsWith('/inbox')) return { status: 200, body: { inbox: [] } }
      if (u.startsWith('/meetings')) return { status: 200, body: [{ id: 'm1', title: 'BPA sync' }] }
      if (u.startsWith('/runs')) return { status: 200, body: { runs: [] } }
      if (u.startsWith('/conversations/')) return { status: 200, body: { conversation: {}, messages: [] } }
      if (u.startsWith('/artifacts/')) return { status: 404, body: { error: 'not found' } }
      return { status: 200, body: [] }
    }
    const t = tools()
    const calls: [string, string][] = [
      ['search', '{"query":"x"}'],
      ['get_task', '{"id":"TASK-1"}'],
      ['list_tasks', '{}'],
      ['search_knowledge', '{"query":"x"}'],
      ['get_knowledge', '{"slug":"s"}'],
      ['list_inbox', '{}'],
      ['get_conversation', '{"id":"CONV-1"}'],
      ['find_meetings', '{}'],
      ['get_meeting', '{"id":"m1"}'],
      ['get_runs', '{}'],
      ['get_daily_report', '{}'],
      ['search_vault', '{"query":"x"}'],
      ['read_vault_note', '{"path":"30-Knowledge/a.md"}']
    ]
    for (const [name, args] of calls) await t.execute(name, args)
    expect(seen.length).toBeGreaterThanOrEqual(calls.length)
    expect(new Set(seen.map((s) => s.method))).toEqual(new Set(['GET']))
  })

  it('execute never throws on junk arguments or an unknown tool', async () => {
    expect(JSON.parse(await tools().execute('get_task', 'not json'))).toEqual({ error: 'invalid arguments' })
    expect(JSON.parse(await tools().execute('drop_tables', '{}'))).toEqual({ error: 'unknown tool' })
  })
})
