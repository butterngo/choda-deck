// TASK-1992 — POST /meetings/:id/note/draft. One test per acceptance criterion,
// over a real companion server with an injected model transport that records
// every call, because half of this contract is "the adapter overrules the model"
// and that can only be seen by scripting a model that is wrong.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createHash } from 'crypto'
import { startCompanionServer, COMPANION_BIND, type CompanionServerHandle } from './http-server'
import type { CompanionServices } from './service-factory'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'
import { HEADINGS } from './meeting-note'

const TOKEN = 'note-draft-test-token'
const KEY = 'FIXTURE-AI-KEY-5566778899'

let dataDir: string
let artifactsDir: string
let handle: CompanionServerHandle
let base: string

let modelCalls = 0
let modelReply: Record<string, unknown> = {}

const fetchImpl = (async () => {
  modelCalls++
  return new Response(
    JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(modelReply), refusal: null } }]
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )
}) as unknown as typeof fetch

/** A model answer with every section present and empty, to override per test. */
function reply(over: Record<string, unknown>): Record<string, unknown> {
  return { tldr: 'tóm tắt', decisions: [], actions: [], questions: [], requests: [], numbers: [], topics: [], ...over }
}

const item = (text: string, atMs: number | null): Record<string, unknown> => ({ text, atMs, who: null })

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choda-note-'))
  artifactsDir = path.join(dataDir, 'artifacts')
  fs.mkdirSync(artifactsDir, { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'ai-key.txt'), KEY)
  fs.writeFileSync(
    path.join(dataDir, 'ai-provider.json'),
    JSON.stringify({ provider: 'azure', endpoint: 'https://fixture.openai.azure.com/openai/v1', deployment: 'gpt-4.1-mini' })
  )

  const services = {
    svc: {
      listProjects: async () => [],
      findTasks: async () => [],
      findInbox: async () => [],
      findConversations: async () => [],
      findWorkspaces: async () => []
    } as unknown as BackendTaskService,
    db: null,
    dbPath: ':memory:',
    intervalMs: 30000,
    bridgeToken: TOKEN,
    artifactsDir,
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
  await handle.close()
  try {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    /* temp dir */
  }
})

beforeEach(() => {
  fs.rmSync(path.join(artifactsDir, 'meetings'), { recursive: true, force: true })
  modelCalls = 0
  modelReply = reply({})
})

function seed(id: string, segments: Array<[number, number, string]> | null): void {
  const dir = path.join(artifactsDir, 'meetings', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'mic.webm'), Buffer.from('audio'))
  fs.writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({ id, startedAt: '2026-09-17T07:00:00Z', endedAt: '2026-09-17T07:30:00Z', tracks: ['mic'], bytes: 5 })
  )
  if (segments) {
    fs.writeFileSync(
      path.join(dir, 'transcript.json'),
      JSON.stringify({
        meetingId: id,
        engine: 'azure-speech',
        api: 'fast-transcription',
        createdAt: '2026-09-17T08:00:00Z',
        segments: segments.map(([startMs, endMs, text]) => ({
          track: 'mic',
          speaker: 'Me',
          startMs,
          endMs,
          text,
          locale: 'vi-VN'
        }))
      })
    )
  }
}

interface Draft {
  status: number
  json: {
    note?: {
      decisions: Array<{ text: string; atMs: number }>
      actions: Array<{ text: string }>
      numbers: Array<{ text: string; conflict: boolean }>
    }
    markdown?: string
    dropped?: Array<{ section: string; text: string; reason: string }>
    error?: string
  }
}

async function draft(id: string, body: Record<string, unknown>): Promise<Draft> {
  const r = await fetch(`${base}/meetings/${id}/note/draft`, {
    method: 'POST',
    headers: { 'x-choda-bridge-token': TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  return { status: r.status, json: (await r.json()) as Draft['json'] }
}

const TWO_SEGMENTS: Array<[number, number, string]> = [
  [0, 10000, 'đoạn một'],
  [20000, 30000, 'đoạn hai']
]

describe('AC-1 — an item outside every segment is dropped, not trusted', () => {
  it('keeps A@5000, drops B@15000 as outside-segments', async () => {
    seed('n1', TWO_SEGMENTS)
    modelReply = reply({ decisions: [item('A', 5000), item('B', 15000)] })
    const r = await draft('n1', { client: 'Chị Kate' })
    expect(r.status).toBe(200)
    expect(r.json.note!.decisions.map((d) => d.text)).toEqual(['A'])
    expect(r.json.dropped).toContainEqual({ section: 'decisions', text: 'B', atMs: 15000, reason: 'outside-segments' })
  })
})

describe('AC-2 — an item with no timestamp is dropped', () => {
  it('moves an action without atMs into dropped as no-timestamp', async () => {
    seed('n2', TWO_SEGMENTS)
    modelReply = reply({ actions: [{ ...item('Gửi mapping', null), owner: 'Chị Kate', due: null }] })
    const r = await draft('n2', { client: 'Chị Kate' })
    expect(r.status).toBe(200)
    expect(r.json.note!.actions).toEqual([])
    expect(r.json.dropped).toContainEqual({ section: 'actions', text: 'Gửi mapping', atMs: null, reason: 'no-timestamp' })
  })
})

describe('AC-3 — the client name comes from the request, never the model', () => {
  it('first markdown line names Acme, not the model’s Globex', async () => {
    seed('n3', TWO_SEGMENTS)
    modelReply = reply({ tldr: 'Globex agreed to everything', decisions: [item('Globex signs', 5000)] })
    const r = await draft('n3', { client: 'Acme' })
    expect(r.status).toBe(200)
    const first = r.json.markdown!.split('\n')[0]
    expect(first).toContain('Acme')
    expect(first).not.toContain('Globex')
  })
})

describe('AC-4 — not transcribed', () => {
  it('409s and never calls the model', async () => {
    seed('n4', null)
    const r = await draft('n4', { client: 'Acme' })
    expect(r.status).toBe(409)
    expect(r.json).toEqual({ error: 'not transcribed' })
    expect(modelCalls).toBe(0)
  })
})

describe('AC-5 — headings come from the language table', () => {
  const order = ['tldr', 'decisions', 'actions', 'questions', 'requests', 'numbers', 'topics', 'transcript'] as const

  function positions(md: string, lang: 'vi' | 'en'): number[] {
    return order.map((k) => md.split('\n').indexOf(HEADINGS[lang][k]))
  }

  it('defaults to vi, in order, with no en-only heading', async () => {
    seed('n5', TWO_SEGMENTS)
    const r = await draft('n5', { client: 'Acme' })
    expect(r.status).toBe(200)
    const pos = positions(r.json.markdown!, 'vi')
    expect(pos.every((p) => p >= 0)).toBe(true)
    expect([...pos].sort((a, b) => a - b)).toEqual(pos)
    expect(r.json.markdown).not.toContain('## Decisions')
    expect(r.json.markdown).not.toContain('## Action items')
  })

  it('language:en is the reverse', async () => {
    seed('n5b', TWO_SEGMENTS)
    const r = await draft('n5b', { client: 'Acme', language: 'en' })
    expect(r.status).toBe(200)
    const pos = positions(r.json.markdown!, 'en')
    expect(pos.every((p) => p >= 0)).toBe(true)
    expect([...pos].sort((a, b) => a - b)).toEqual(pos)
    expect(r.json.markdown).not.toContain('## Quyết định')
    expect(r.json.markdown).not.toContain('## Việc cần làm')
  })
})

describe('AC-6 — ▶ timestamp format', () => {
  it('754000 ms renders as ▶ 12:34', async () => {
    seed('n6', [[750000, 760000, 'chốt phần đó']])
    modelReply = reply({ decisions: [item('Chốt UI', 754000)] })
    const r = await draft('n6', { client: 'Acme' })
    expect(r.status).toBe(200)
    const row = r.json.markdown!.split('\n').find((l) => l.includes('Chốt UI'))
    expect(row).toContain('▶ 12:34')
  })
})

describe('AC-7 — internal parts stay out unless asked for', () => {
  const parts = [
    { fromMs: 0, toMs: 10000, kind: 'client' },
    { fromMs: 10000, toMs: 30000, kind: 'internal' }
  ]

  it('drops B@20000 as internal-part by default', async () => {
    seed('n7', TWO_SEGMENTS)
    modelReply = reply({ decisions: [item('A', 5000), item('B', 20000)] })
    const r = await draft('n7', { client: 'Chị Kate', parts })
    expect(r.status).toBe(200)
    expect(r.json.note!.decisions.map((d) => d.text)).toEqual(['A'])
    expect(r.json.dropped).toContainEqual({ section: 'decisions', text: 'B', atMs: 20000, reason: 'internal-part' })
  })

  it('keeps both with includeInternal:true', async () => {
    seed('n7b', TWO_SEGMENTS)
    modelReply = reply({ decisions: [item('A', 5000), item('B', 20000)] })
    const r = await draft('n7b', { client: 'Chị Kate', parts, includeInternal: true })
    expect(r.status).toBe(200)
    expect(r.json.note!.decisions.map((d) => d.text)).toEqual(['A', 'B'])
  })
})

describe('AC-8 — the glossary is applied by the adapter, not left to the model', () => {
  it('"5 cái comparency" becomes "5 cái competency"', async () => {
    seed('n8', TWO_SEGMENTS)
    // The stub model ignores the glossary entirely, as a real one may.
    modelReply = reply({ decisions: [item('Dùng 5 cái comparency', 5000)] })
    const r = await draft('n8', {
      client: 'Chị Kate',
      glossary: [{ heard: ['comparency', 'confessency'], term: 'competency' }]
    })
    expect(r.status).toBe(200)
    expect(r.json.markdown).toContain('5 cái competency')
    expect(r.json.markdown).not.toContain('comparency')
  })
})

describe('AC-9 — a number said two ways is flagged', () => {
  it('5 vs 8 gets conflict:true and ⚠; a single value does not', async () => {
    seed('n9', [
      [130000, 140000, '5 cái competency'],
      [985000, 995000, '8 cái competency'],
      [20000, 30000, '5 rubric']
    ])
    modelReply = reply({
      numbers: [
        { text: 'competency count', values: [{ value: '5', atMs: 137000 }, { value: '8', atMs: 989000 }] },
        { text: 'rubric count', values: [{ value: '5', atMs: 25000 }] }
      ]
    })
    const r = await draft('n9', { client: 'Chị Kate' })
    expect(r.status).toBe(200)
    const byText = Object.fromEntries(r.json.note!.numbers.map((n) => [n.text, n.conflict]))
    expect(byText).toEqual({ 'competency count': true, 'rubric count': false })
    const lines = r.json.markdown!.split('\n')
    expect(lines.find((l) => l.includes('competency count'))).toContain('⚠')
    expect(lines.find((l) => l.includes('rubric count'))).not.toContain('⚠')
  })
})

describe('AC-10 — drafting writes nothing', () => {
  it('every file under the meeting directory keeps its sha256', async () => {
    seed('n10', TWO_SEGMENTS)
    const dir = path.join(artifactsDir, 'meetings', 'n10')
    const hashAll = (): Record<string, string> =>
      Object.fromEntries(
        fs.readdirSync(dir).map((f) => [f, createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex')])
      )
    const before = hashAll()
    modelReply = reply({ decisions: [item('A', 5000)] })
    expect((await draft('n10', { client: 'Acme' })).status).toBe(200)
    expect(hashAll()).toEqual(before)
  })
})
