// TASK-1936 — one test per acceptance criterion for the paid route.
//
// Every provider call is scripted and RECORDED. The recorder is the point: five
// of these criteria are about calls that must NOT happen, and "the response
// looked right" cannot tell you whether one left the machine.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createHash } from 'crypto'
import { startCompanionServer, COMPANION_BIND, type CompanionServerHandle } from './http-server'
import type { CompanionServices } from './service-factory'
import type { WorkspaceOperations } from '../../core/domain/interfaces/workspace-repository.interface'

const TOKEN = 'ws-diagram-token'
const WS = 'main'
/** Distinctive on purpose: every captured body and log line is searched for it. */
const FIXTURE_KEY = 'AZURE-KEY-DO-NOT-LEAK-9182'

const DOC = [
  '# doc',
  '',
  '```mermaid',
  'sequenceDiagram',
  '  A->>B: hi',
  '```',
  '',
  'prose',
  ''
].join('\n')

let root: string
let dataDir: string
let handle: CompanionServerHandle
let base: string

/** Every outbound provider request, in order. */
let calls: { url: string; body: string }[] = []
/** Scripted answers, consumed one per call. */
let script: (() => Promise<Response>)[] = []

const ok = (mermaid: string): (() => Promise<Response>) => async () =>
  new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify({ mermaid }) } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )

const status = (code: number, headers: Record<string, string> = {}): (() => Promise<Response>) =>
  async () => new Response('{}', { status: code, headers })

const boom = (): (() => Promise<Response>) => async () => {
  throw new Error('socket hang up')
}

const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
  calls.push({ url: String(url), body: String(init?.body ?? '') })
  const next = script.shift()
  if (!next) throw new Error('unscripted provider call')
  return next()
}) as unknown as typeof fetch

function writeProvider(): void {
  fs.writeFileSync(
    path.join(dataDir, 'ai-provider.json'),
    JSON.stringify({ provider: 'azure', endpoint: 'https://example/openai/v1', deployment: 'gpt-x' })
  )
  fs.writeFileSync(path.join(dataDir, 'ai-key.txt'), FIXTURE_KEY, { mode: 0o600 })
}

function removeProvider(): void {
  for (const f of ['ai-provider.json', 'ai-key.txt']) {
    fs.rmSync(path.join(dataDir, f), { force: true })
  }
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-diagram-'))
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-diagram-data-'))
  fs.writeFileSync(path.join(root, 'doc.md'), DOC)

  const svc = {
    getWorkspace: async (asked: string) =>
      asked === WS ? ({ id: WS, label: 'Main', cwd: root, projectId: 'p1' } as never) : null
  } as unknown as WorkspaceOperations

  const services = {
    svc,
    db: null,
    dbPath: ':memory:',
    intervalMs: 30000,
    bridgeToken: TOKEN,
    dataDir,
    fetchImpl,
    pull: async () => ({ upserted: 0, tombstoned: 0, cursor: 0 }),
    push: async () => ({ drained: 0, conflicts: 0, remaining: 0, reachable: true }),
    close: () => {}
  } as unknown as CompanionServices

  handle = await startCompanionServer(services, 0)
  base = `http://${COMPANION_BIND}:${handle.address.port}`
})

afterAll(async () => {
  await handle?.close()
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(dataDir, { recursive: true, force: true })
})

beforeEach(() => {
  calls = []
  script = []
  fs.writeFileSync(path.join(root, 'doc.md'), DOC)
  writeProvider()
})

const docHash = (): string =>
  createHash('sha256').update(fs.readFileSync(path.join(root, 'doc.md'))).digest('hex')

async function propose(
  body: Record<string, unknown> = {}
): Promise<{ status: number; json: Record<string, unknown>; retryAfter: string | null }> {
  const res = await fetch(`${base}/workspace-docs/diagram`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-choda-bridge-token': TOKEN },
    body: JSON.stringify({ workspaceId: WS, rel: 'doc.md', fenceIndex: 0, instruction: 'add C', ...body })
  })
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
    retryAfter: res.headers.get('retry-after')
  }
}

// -----------------------------------------------------------------------------

describe('AC-1 — an unparseable proposal is refused, and nothing is written', () => {
  it('two bad answers → 422 with the parse error, attempts 2, file untouched', async () => {
    const before = docHash()
    script = [ok('not a diagram at all'), ok('still not a diagram')]

    const { status, json } = await propose()
    expect(status).toBe(422)
    expect(json.error).toBe('model output does not parse')
    expect(json.attempts).toBe(2)
    expect(typeof json.parseError).toBe('string')
    // This route has no business writing at all — proven, not assumed.
    expect(docHash()).toBe(before)
    expect(calls).toHaveLength(2)
  })
})

describe('AC-2 — the retry is real', () => {
  it('junk once then valid → 200 with attempts 2', async () => {
    script = [ok('nonsense'), ok('sequenceDiagram\n  A->>C: hi')]
    const { status, json } = await propose()
    expect(status).toBe(200)
    expect(json.attempts).toBe(2)
    expect(json.mermaid).toContain('A->>C')
    // The retry prompt must carry the parse error, or the model is being asked
    // the same question twice and the second attempt is a coin flip.
    expect(calls[1]!.body).toContain('did not parse')
  })
})

describe('AC-3 — the retry does not fire when nothing failed', () => {
  it('a first answer that parses → 200, attempts 1, exactly one provider call', async () => {
    script = [ok('sequenceDiagram\n  A->>B: hi')]
    const { status, json } = await propose()
    expect(status).toBe(200)
    expect(json.attempts).toBe(1)
    // A retry that runs when nothing failed doubles the bill silently.
    expect(calls).toHaveLength(1)
  })
})

describe('AC-4 — no key is the normal state, not a failure', () => {
  it('501 and ZERO provider calls', async () => {
    removeProvider()
    const { status, json } = await propose()
    expect(status).toBe(501)
    expect(json.error).toBe('no model configured')
    expect(calls).toEqual([])
    expect(json.mermaid).toBeUndefined() // never a fabricated answer
  })
})

describe('AC-5 — provider failures are distinguished', () => {
  it('HTTP 500 → 502 kind api', async () => {
    script = [status(500)]
    const { status: code, json } = await propose()
    expect(code).toBe(502)
    expect(json.kind).toBe('api')
  })

  it('a transport throw → 502 kind network', async () => {
    script = [boom()]
    const { status: code, json } = await propose()
    expect(code).toBe(502)
    // Different fact, different action: check the network, not the key. Mapping
    // both to one kind makes the union decorative where a person reads it.
    expect(json.kind).toBe('network')
  })

  it('429 is passed through with its retry hint', async () => {
    script = [status(429, { 'retry-after': '30' })]
    const { status: code, retryAfter } = await propose()
    expect(code).toBe(429)
    expect(retryAfter).toBe('30')
  })
})

describe('AC-6 — a bad fence index costs nothing', () => {
  it('404 naming the index and the count, with ZERO provider calls', async () => {
    const { status, json } = await propose({ fenceIndex: 7 })
    expect(status).toBe(404)
    expect(json.error).toBe('no fence 7: doc.md has 1')
    // Discovering a client bug after paying for a call would be charging the
    // user for our own 400.
    expect(calls).toEqual([])
  })

  it('CONTROL — index 0 does reach the provider', async () => {
    // Without this, a route that 404'd every index would pass the test above.
    script = [ok('sequenceDiagram\n  A->>B: hi')]
    const { status } = await propose({ fenceIndex: 0 })
    expect(status).toBe(200)
    expect(calls).toHaveLength(1)
  })
})

describe('AC-7 — the cost boundary is the route, not a flag', () => {
  it('nothing but /workspace-docs/diagram reaches the provider', async () => {
    // Every one of these carries a body that WOULD be accepted by the paid
    // route. That is the whole discriminator: if a flag could fold the paid
    // path into the free one, these requests have nothing else stopping them.
    // An earlier version of this test sent `{ mermaid }` instead and passed
    // against a deliberately folded-in flag — it was refused for a missing
    // field, not for being on the wrong route, and proved nothing.
    const paidBody = JSON.stringify({
      workspaceId: WS,
      rel: 'doc.md',
      fenceIndex: 0,
      instruction: 'add C'
    })
    const headers = { 'content-type': 'application/json', 'x-choda-bridge-token': TOKEN }

    const results = await Promise.all([
      fetch(`${base}/workspace-docs/diagram/check?ai=true`, { method: 'POST', headers, body: paidBody }),
      fetch(`${base}/workspace-docs/diagram/check?review=1`, { method: 'POST', headers, body: paidBody }),
      fetch(`${base}/workspace-docs/diagram/check`, {
        method: 'POST',
        headers: { ...headers, 'x-ai': 'true' },
        body: paidBody
      }),
      fetch(`${base}/workspace-docs/${WS}/doc.md?ai=true`, {
        headers: { 'x-choda-bridge-token': TOKEN }
      })
    ])
    for (const r of results) expect(r.status).toBeLessThan(500)
    expect(calls).toEqual([])
  })

  it('CONTROL — the same body on the paid route DOES reach the provider', async () => {
    // Without this the assertion above would also pass against a build where
    // the provider is unreachable for some unrelated reason.
    script = [ok('sequenceDiagram\n  A->>B: hi')]
    const { status } = await propose()
    expect(status).toBe(200)
    expect(calls).toHaveLength(1)
  })
})

describe('AC-8 — the key never appears in anything a caller or a log can read', () => {
  it('across the 200, 422, 501 and 502 paths', async () => {
    const bodies: string[] = []
    const logged: string[] = []
    const realLog = console.log
    const realErr = console.error
    console.log = (...a: unknown[]) => void logged.push(a.map(String).join(' '))
    console.error = (...a: unknown[]) => void logged.push(a.map(String).join(' '))
    try {
      script = [ok('sequenceDiagram\n  A->>B: hi')]
      bodies.push(JSON.stringify((await propose()).json))

      script = [ok('junk'), ok('junk')]
      bodies.push(JSON.stringify((await propose()).json))

      script = [status(500)]
      bodies.push(JSON.stringify((await propose()).json))

      removeProvider()
      bodies.push(JSON.stringify((await propose()).json))
    } finally {
      console.log = realLog
      console.error = realErr
    }

    for (const b of bodies) expect(b).not.toContain(FIXTURE_KEY)
    for (const l of logged) expect(l).not.toContain(FIXTURE_KEY)
    // The key DID travel — otherwise this test proves only that we never
    // configured one.
    expect(calls.length).toBeGreaterThan(0)
  })
})

describe('the guards the criteria imply', () => {
  it('a missing instruction is a 400 and costs nothing', async () => {
    const res = await fetch(`${base}/workspace-docs/diagram`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-choda-bridge-token': TOKEN },
      body: JSON.stringify({ workspaceId: WS, rel: 'doc.md', fenceIndex: 0 })
    })
    expect(res.status).toBe(400)
    expect(calls).toEqual([])
  })

  it('a wrong token is refused before the key is read', async () => {
    const res = await fetch(`${base}/workspace-docs/diagram`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-choda-bridge-token': 'wrong' },
      body: JSON.stringify({ workspaceId: WS, rel: 'doc.md', fenceIndex: 0, instruction: 'x' })
    })
    expect(res.status).toBe(401)
    expect(calls).toEqual([])
  })

  it('a traversal is refused without a provider call', async () => {
    const { status } = await propose({ rel: '../outside.md' })
    expect(status).toBeGreaterThanOrEqual(400)
    expect(calls).toEqual([])
  })

  it('a file with no fences 404s rather than inventing one', async () => {
    fs.writeFileSync(path.join(root, 'plain.md'), '# nothing here\n')
    const { status, json } = await propose({ rel: 'plain.md' })
    expect(status).toBe(404)
    expect(json.error).toBe('no fence 0: plain.md has 0')
    expect(calls).toEqual([])
  })
})
