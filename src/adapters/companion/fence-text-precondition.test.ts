// TASK-1943 AC-3 — a request naming a fence the adapter resolves differently is
// REFUSED rather than served.
//
// The fixture test next door makes a disagreement VISIBLE at build time. This
// one makes it IMPOSSIBLE TO ACT ON at runtime, which is the half that protects
// a reader whose client is a version behind.
//
// The assertion that carries the file is the provider call count. A 409 that
// still spent money would be a worse bug than the one being fixed, and a test
// that only checked the status code could not tell the difference.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createHash } from 'crypto'
import { startCompanionServer, COMPANION_BIND, type CompanionServerHandle } from './http-server'
import type { CompanionServices } from './service-factory'
import type { WorkspaceOperations } from '../../core/domain/interfaces/workspace-repository.interface'

const TOKEN = 'fence-precondition-token'
const WS = 'main'

/** Two fences, so "the wrong one" is a real thing to land on. */
const DOC = [
  '# doc',
  '',
  '```mermaid',
  'flowchart TD',
  '  FIRST-->A',
  '```',
  '',
  'prose between them',
  '',
  '```mermaid',
  'flowchart TD',
  '  SECOND-->B',
  '```',
  ''
].join('\n')

const FENCE_0 = 'flowchart TD\n  FIRST-->A'
const FENCE_1 = 'flowchart TD\n  SECOND-->B'

let root: string
let dataDir: string
let handle: CompanionServerHandle
let base: string
let calls: { url: string; body: string }[] = []

const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
  calls.push({ url: String(url), body: String(init?.body ?? '') })
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ mermaid: 'flowchart TD\n  X-->Y' }) } }]
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )
}) as unknown as typeof fetch

const docPath = (): string => path.join(root, 'doc.md')
const docHash = (): string => createHash('sha256').update(fs.readFileSync(docPath())).digest('hex')

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fence-pre-'))
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fence-pre-data-'))
  fs.writeFileSync(
    path.join(dataDir, 'ai-provider.json'),
    JSON.stringify({ provider: 'azure', endpoint: 'https://example/openai/v1', deployment: 'gpt-x' })
  )
  fs.writeFileSync(path.join(dataDir, 'ai-key.txt'), 'KEY', { mode: 0o600 })

  const svc = {
    getWorkspace: async (asked: string) =>
      asked === WS ? ({ id: WS, label: 'Main', cwd: root, projectId: 'p1' } as never) : null
  } as unknown as WorkspaceOperations

  handle = await startCompanionServer(
    {
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
    } as unknown as CompanionServices,
    0
  )
  base = `http://${COMPANION_BIND}:${handle.address.port}`
})

afterAll(async () => {
  await handle?.close()
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(dataDir, { recursive: true, force: true })
})

beforeEach(() => {
  calls = []
  fs.writeFileSync(docPath(), DOC)
})

async function propose(body: Record<string, unknown>) {
  const res = await fetch(`${base}/workspace-docs/diagram`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-choda-bridge-token': TOKEN },
    body: JSON.stringify({
      workspaceId: WS,
      rel: 'doc.md',
      instruction: 'add a node',
      ...body
    })
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

// Any test below that reaches a 200 makes the adapter PARSE the model's answer,
// and the first parse in a fresh process pays mermaid's dynamic import — measured
// at ~64 s cold here, against ~10 ms once warm (TASK-1941). The budget is for the
// import, not for the assertion; whichever 200-path test runs first pays it.
const COLD_IMPORT_BUDGET_MS = 120_000

describe('TASK-1943 — the fence-text precondition', () => {
  it('REFUSES when the client names a fence the adapter resolves differently', async () => {
    const before = docHash()
    // The client believes index 1 holds FENCE_0 — the exact confusion a drifted
    // second implementation produces.
    const res = await propose({ fenceIndex: 1, fenceText: FENCE_0 })

    expect(res.status).toBe(409)
    expect(String(res.json.error)).toContain('does not match')
    // The message has to tell a human what to DO, not merely that something is wrong.
    expect(String(res.json.detail)).toContain('Reload')
    // The load-bearing assertion: refused BEFORE the provider was called. A 409
    // that still spent money would be worse than the bug this prevents.
    expect(calls).toHaveLength(0)
    expect(docHash()).toBe(before)
  })

  it('SERVES when the text matches — the control', async () => {
    const res = await propose({ fenceIndex: 1, fenceText: FENCE_1 })
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    // And it asked the model about the fence the client actually named.
    expect(calls[0]?.body).toContain('SECOND-->B')
    expect(calls[0]?.body).not.toContain('FIRST-->A')
  }, COLD_IMPORT_BUDGET_MS)

  it('still serves a client that sends no fenceText, and says why that is allowed', async () => {
    // Backward compatibility is deliberate: the shipped app predates this field,
    // and breaking it would be a worse failure than the one being fixed. The
    // exposure for an old client is unchanged, not newly introduced.
    const res = await propose({ fenceIndex: 0 })
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.body).toContain('FIRST-->A')
  }, COLD_IMPORT_BUDGET_MS)

  it('a non-string fenceText is ignored rather than trusted', async () => {
    // A client sending `null` or a number must not accidentally satisfy the
    // check by being unequal-but-not-a-string, nor be refused as a mismatch.
    const res = await propose({ fenceIndex: 0, fenceText: 42 })
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
  }, COLD_IMPORT_BUDGET_MS)

  it('an out-of-range index is still a 404, not a 409', async () => {
    // Order matters: the index is resolved first, so "no such fence" stays its
    // own answer instead of being reported as a text mismatch.
    const res = await propose({ fenceIndex: 9, fenceText: FENCE_0 })
    expect(res.status).toBe(404)
    expect(String(res.json.error)).toContain('has 2')
    expect(calls).toHaveLength(0)
  })
})
