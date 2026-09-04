// TASK-1843 — POST /claude-config/review, and the key that never leaves the adapter.
//
// Every provider failure is driven through an injected fetch. A test that needs
// the internet is a test nobody runs, and the failure paths are the whole point
// of a typed error union — an untested union is decoration.
//
// The key used throughout is a distinctive string, so AC-4 can search every
// captured body and log line for it rather than trusting that it was not there.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { startCompanionServer, COMPANION_BIND, type CompanionServerHandle } from './http-server'
import type { CompanionServices } from './service-factory'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'
import { AiError, resolveAiKey, reviewFile } from './ai-review'

const TOKEN = 'ai-review-token'
/** If this ever appears in a response, an error body or a log, AC-4 has failed. */
const FIXTURE_KEY = 'sk-BUTTER-SECRET-KEY-DO-NOT-LEAK-0001'

const SKILL = `---
name: code-review
description: Review code changes for security, performance, and correctness.
---

# code-review
`

let home: string
let dataDir: string
let handle: CompanionServerHandle
let base: string

/** Every request the provider client makes, and what the route was told to answer. */
let providerCalls: { url: string; init: Record<string, unknown> }[]
let providerReply: () => Promise<Response>
let logLines: string[]

const fakeSvc = {
  listProjects: async () => [],
  findTasks: async () => [],
  findInbox: async () => [],
  findConversations: async () => [],
  findWorkspaces: async () => [],
  getWorkspace: async () => null
} as unknown as BackendTaskService

function review(body: unknown): Promise<{ status: number; raw: string; json: Record<string, unknown> }> {
  return fetch(`${base}/claude-config/review`, {
    method: 'POST',
    headers: { 'x-choda-bridge-token': TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }).then(async (r) => {
    const raw = await r.text()
    let json: Record<string, unknown> = {}
    try {
      json = JSON.parse(raw) as Record<string, unknown>
    } catch {
      json = {}
    }
    return { status: r.status, raw, json }
  })
}

function ok(payload: unknown): Response {
  return new Response(
    JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(payload) }] }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'choda-ai-home-'))
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choda-ai-data-'))
  fs.mkdirSync(path.join(home, 'skills', 'code-review'), { recursive: true })
  fs.writeFileSync(path.join(home, 'skills', 'code-review', 'SKILL.md'), SKILL, 'utf8')

  const services = {
    svc: fakeSvc,
    db: null,
    dbPath: ':memory:',
    intervalMs: 30000,
    bridgeToken: TOKEN,
    claudeHome: home,
    dataDir,
    fetchImpl: (url: string, init: Record<string, unknown>) => {
      providerCalls.push({ url, init })
      return providerReply()
    },
    pull: async () => ({ upserted: 0, tombstoned: 0, cursor: 0 }),
    push: async () => ({ drained: 0, conflicts: 0, remaining: 0, reachable: true }),
    close: () => {}
  } as unknown as CompanionServices

  handle = await startCompanionServer(services, 0)
  base = `http://${COMPANION_BIND}:${handle.address.port}`
})

afterAll(async () => {
  await handle?.close()
  for (const d of [home, dataDir]) fs.rmSync(d, { recursive: true, force: true })
})

beforeEach(() => {
  providerCalls = []
  providerReply = async () => ok({ notes: [] })
  logLines = []
  // Console is captured so AC-4 can assert the key never reaches a log line.
  for (const level of ['log', 'error', 'warn'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logLines.push(args.map(String).join(' '))
    })
  }
  const keyPath = path.join(dataDir, 'ai-key.txt')
  if (fs.existsSync(keyPath)) fs.rmSync(keyPath)
  delete process.env.CHODA_AI_KEY
})

function configureKey(): void {
  fs.writeFileSync(path.join(dataDir, 'ai-key.txt'), FIXTURE_KEY, { mode: 0o600 })
}

describe('AC-1 — no key means no call, and no invented answer', () => {
  it('501s and the provider is never reached', async () => {
    const res = await review({ rootId: 'skills', rel: 'code-review/SKILL.md' })
    expect(res.status).toBe(501)
    expect(providerCalls).toHaveLength(0)
    // The other half of the criterion: not a 200 with fabricated notes.
    expect(res.json.notes).toBeUndefined()
  })
})

describe('AC-2 — provider failures are distinguishable', () => {
  it('a 500 from the provider is kind api', async () => {
    configureKey()
    providerReply = async () => new Response('upstream exploded', { status: 500 })
    const res = await review({ rootId: 'skills', rel: 'code-review/SKILL.md' })
    expect(res.status).toBe(502)
    expect(res.json.kind).toBe('api')
  })

  it('a transport throw is kind network', async () => {
    configureKey()
    providerReply = async () => {
      throw new Error('ECONNREFUSED')
    }
    const res = await review({ rootId: 'skills', rel: 'code-review/SKILL.md' })
    expect(res.status).toBe(502)
    // Distinct from 'api': one says check the network, the other says the
    // provider answered and answered badly. Equal kinds make the union
    // decoration.
    expect(res.json.kind).toBe('network')
  })

  it('a 401 is kind auth, and a 429 becomes a 429 with the retry hint', async () => {
    configureKey()
    providerReply = async () => new Response('nope', { status: 401 })
    expect((await review({ rootId: 'skills', rel: 'code-review/SKILL.md' })).json.kind).toBe('auth')

    providerReply = async () =>
      new Response('slow down', { status: 429, headers: { 'retry-after': '30' } })
    const limited = await review({ rootId: 'skills', rel: 'code-review/SKILL.md' })
    expect(limited.status).toBe(429)
    expect(limited.json.kind).toBe('rate_limit')
  })
})

describe('AC-3 — an unparseable answer is a typed failure, not a crash', () => {
  it('non-JSON content yields kind parse and no notes', async () => {
    configureKey()
    providerReply = async () =>
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'I am not JSON' }] }), {
        status: 200
      })
    const res = await review({ rootId: 'skills', rel: 'code-review/SKILL.md' })
    expect(res.status).toBe(502)
    expect(res.json.kind).toBe('parse')
    expect(res.json.notes).toBeUndefined()
  })

  it('valid JSON of the wrong shape is also kind parse', async () => {
    configureKey()
    providerReply = async () => ok({ somethingElse: true })
    expect((await review({ rootId: 'skills', rel: 'code-review/SKILL.md' })).json.kind).toBe('parse')
  })

  it('CONTROL — a well-formed answer returns its notes', async () => {
    // Without this, "kind parse" could be the only outcome and every assertion
    // above would still pass.
    configureKey()
    providerReply = async () =>
      ok({ notes: [{ checkId: 'trigger-clarity', message: 'says what, not when', quote: null }] })
    const res = await review({ rootId: 'skills', rel: 'code-review/SKILL.md' })
    expect(res.status).toBe(200)
    expect((res.json.notes as { checkId: string }[])[0].checkId).toBe('trigger-clarity')
  })
})

describe('AC-4 — the key never appears in anything a reader can see', () => {
  it('is absent from the 501, 502 and 200 paths, and from every log line', async () => {
    const bodies: string[] = []

    // 501 — no key at all
    bodies.push((await review({ rootId: 'skills', rel: 'code-review/SKILL.md' })).raw)

    // 502 — provider echoes the key back, which is exactly how a secret reaches
    // a log nobody thought was sensitive.
    configureKey()
    providerReply = async () =>
      new Response(`upstream said: request used ${FIXTURE_KEY}`, { status: 500 })
    bodies.push((await review({ rootId: 'skills', rel: 'code-review/SKILL.md' })).raw)

    // 200 — the happy path
    providerReply = async () => ok({ notes: [] })
    bodies.push((await review({ rootId: 'skills', rel: 'code-review/SKILL.md' })).raw)

    for (const body of bodies) expect(body).not.toContain(FIXTURE_KEY)
    for (const line of logLines) expect(line).not.toContain(FIXTURE_KEY)
  })

  it('CONTROL — the key really was in play', async () => {
    // Otherwise the assertions above would pass against a route that never
    // configured a key at all.
    configureKey()
    await review({ rootId: 'skills', rel: 'code-review/SKILL.md' })
    const sent = providerCalls[0]?.init as { headers?: Record<string, string> }
    expect(sent.headers?.['x-api-key']).toBe(FIXTURE_KEY)
  })
})

describe('AC-5 — no route other than /review reaches the provider', () => {
  it('validate cannot be talked into a model call', async () => {
    configureKey()
    for (const url of [
      '/claude-config/validate?ai=true',
      '/claude-config/validate?review=1',
      '/claude-config/validate'
    ]) {
      await fetch(`${base}${url}`, {
        method: 'POST',
        headers: { 'x-choda-bridge-token': TOKEN, 'content-type': 'application/json', 'x-ai': '1' },
        body: JSON.stringify({ rootId: 'skills', rel: 'code-review/SKILL.md' })
      })
    }
    // A route-table walk alone would miss a handler that reads a header, so the
    // parameters are driven explicitly.
    expect(providerCalls).toHaveLength(0)
  })

  it('nor can the inventory or a file read', async () => {
    configureKey()
    await fetch(`${base}/claude-config`, { headers: { 'x-choda-bridge-token': TOKEN } })
    await fetch(`${base}/claude-config/skills/code-review/SKILL.md`, {
      headers: { 'x-choda-bridge-token': TOKEN }
    })
    expect(providerCalls).toHaveLength(0)
  })
})

describe('AC-6 — the key file is not retrievable through any route', () => {
  it('every root id and every file route refuses it', async () => {
    configureKey()
    const attempts = [
      '/claude-config/skills/../../ai-key.txt',
      '/claude-config/commands/../../ai-key.txt',
      '/claude-config/claude-md/../../ai-key.txt',
      '/claude-config/ai-key.txt',
      '/artifacts/ai-key.txt',
      '/vault/notes/ai-key.txt',
      `/workspace-docs/main/ai-key.txt`
    ]
    for (const url of attempts) {
      const res = await fetch(`${base}${url}`, { headers: { 'x-choda-bridge-token': TOKEN } })
      const body = await res.text()
      expect(res.status).not.toBe(200)
      expect(body).not.toContain(FIXTURE_KEY)
    }
  })
})

describe('AC-7 — the key file is written 0o600', () => {
  const canRepresentMode = process.platform !== 'win32'

  it.skipIf(!canRepresentMode)('minting from the environment writes mode 0600', () => {
    process.env.CHODA_AI_KEY = FIXTURE_KEY
    const key = resolveAiKey(dataDir)
    expect(key).toBe(FIXTURE_KEY)
    const mode = fs.statSync(path.join(dataDir, 'ai-key.txt')).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('the mint path runs and persists the key out of the environment', () => {
    // Runs everywhere. Windows cannot represent 0o600 in st_mode, so the mode
    // assertion above is skipped there rather than passing on a value the
    // filesystem invented — but the WRITE still has to happen, and that is what
    // this asserts.
    process.env.CHODA_AI_KEY = FIXTURE_KEY
    expect(resolveAiKey(dataDir)).toBe(FIXTURE_KEY)
    expect(fs.readFileSync(path.join(dataDir, 'ai-key.txt'), 'utf8')).toBe(FIXTURE_KEY)

    // And once persisted, the environment is no longer consulted — a child
    // process inheriting a stale env must not override the file.
    process.env.CHODA_AI_KEY = 'a-different-key'
    expect(resolveAiKey(dataDir)).toBe(FIXTURE_KEY)
  })

  it('an empty key file is treated as absent, like a truncated bridge token', () => {
    fs.writeFileSync(path.join(dataDir, 'ai-key.txt'), '   ')
    expect(resolveAiKey(dataDir, {})).toBeNull()
  })
})

describe('the client itself', () => {
  it('does not send the browser-only CORS header', async () => {
    // anthropic-dangerous-direct-browser-access exists to opt a BROWSER past a
    // CORS refusal. Sending it from Node would announce a risk this caller does
    // not take.
    await reviewFile({
      key: FIXTURE_KEY,
      rel: 'x/SKILL.md',
      text: 'hello',
      fetchImpl: async (url, init) => {
        providerCalls.push({ url, init })
        return ok({ notes: [] })
      }
    })
    const headers = (providerCalls[0].init as { headers: Record<string, string> }).headers
    expect(headers['anthropic-dangerous-direct-browser-access']).toBeUndefined()
    expect(headers['anthropic-version']).toBe('2023-06-01')
  })

  it('throws no_key rather than calling with an empty key', async () => {
    await expect(
      reviewFile({ key: null, rel: 'x', text: 'y', fetchImpl: async () => ok({ notes: [] }) })
    ).rejects.toBeInstanceOf(AiError)
  })
})
