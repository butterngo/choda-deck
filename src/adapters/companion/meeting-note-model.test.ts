// TASK-2004 — picking which deployment drafts a meeting note.
//
// The transport is a recorder that answers three different URLs: the deployments
// listing, the model catalog, and the chat completion. That separation is the
// point — the catalog is what a picked deployment is checked against, and a test
// whose transport answers everything identically cannot tell a validated pick
// from an unvalidated one.
//
// AC-2 is the control: with nothing picked the outbound model must still be the
// configured deployment. Without it, an implementation that ignores the pick
// entirely would look correct.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { startCompanionServer, COMPANION_BIND, type CompanionServerHandle } from './http-server'
import type { CompanionServices } from './service-factory'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'

const TOKEN = 'tok-note-model'
const KEY = 'fixture-key'
const CONFIGURED = 'gpt-4.1-mini'
const OTHER = 'gpt-4o'

let dataDir: string
let artifactsDir: string
let handle: CompanionServerHandle
let base: string

/** Every outbound call, so "zero requests to the provider" is countable. */
let outbound: Array<{ url: string; model?: string }> = []

const fetchImpl = (async (input: RequestInfo, init?: RequestInit) => {
  const url = String(input)
  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

  if (url.includes('/openai/deployments')) {
    outbound.push({ url })
    return json({
      data: [
        { id: CONFIGURED, model: CONFIGURED, status: 'succeeded' },
        { id: OTHER, model: OTHER, status: 'succeeded' },
        { id: 'text-embedding-3-large', model: 'text-embedding-3-large', status: 'succeeded' }
      ]
    })
  }
  if (url.endsWith('/models')) {
    outbound.push({ url })
    return json({
      data: [
        { id: CONFIGURED, capabilities: { chat_completion: true } },
        { id: OTHER, capabilities: { chat_completion: true } },
        { id: 'text-embedding-3-large', capabilities: { chat_completion: false } }
      ]
    })
  }

  const sent = init?.body ? (JSON.parse(String(init.body)) as { model?: string }) : {}
  outbound.push({ url, model: sent.model })
  return json({
    choices: [
      {
        finish_reason: 'stop',
        message: {
          content: JSON.stringify({
            tldr: 'tóm tắt',
            decisions: [],
            actions: [],
            questions: [],
            requests: [],
            numbers: [],
            topics: []
          }),
          refusal: null
        }
      }
    ]
  })
}) as unknown as typeof fetch

/** Only the chat completions — the catalog reads are not calls "to the model". */
const completions = (): Array<{ url: string; model?: string }> =>
  outbound.filter((c) => !c.url.includes('/openai/deployments') && !c.url.endsWith('/models'))

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choda-note-model-'))
  artifactsDir = path.join(dataDir, 'artifacts')
  fs.mkdirSync(artifactsDir, { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'ai-key.txt'), KEY)
  fs.writeFileSync(
    path.join(dataDir, 'ai-provider.json'),
    JSON.stringify({
      provider: 'azure',
      endpoint: 'https://fixture.openai.azure.com/openai/v1',
      deployment: CONFIGURED
    })
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
  await handle?.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

beforeEach(() => {
  outbound = []
})

function seed(id: string): void {
  const dir = path.join(artifactsDir, 'meetings', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({ id, startedAt: '2026-09-17T07:00:00.000Z', endedAt: '2026-09-17T07:30:00.000Z', tracks: ['mic'] })
  )
  fs.writeFileSync(
    path.join(dir, 'transcript.json'),
    JSON.stringify({
      segments: [{ track: 'mic', speaker: 'Me', startMs: 0, endMs: 10000, text: 'đoạn một', locale: 'vi-VN' }]
    })
  )
}

interface Draft {
  status: number
  json: { usedModel?: string; error?: string; model?: string }
}

async function draft(id: string, body: Record<string, unknown>): Promise<Draft> {
  const r = await fetch(`${base}/meetings/${id}/note/draft`, {
    method: 'POST',
    headers: { 'x-choda-bridge-token': TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ client: 'Chị Kate', ...body })
  })
  return { status: r.status, json: (await r.json()) as Draft['json'] }
}

describe('AC-1 — a picked deployment is the one that answers', () => {
  it('sends the picked model, not the configured one', async () => {
    seed('m-pick')
    const r = await draft('m-pick', { model: OTHER })
    expect(r.status).toBe(200)
    expect(completions()).toHaveLength(1)
    expect(completions()[0].model).toBe(OTHER)
    expect(completions()[0].model).not.toBe(CONFIGURED)
  })
})

describe('AC-2 — nothing picked still means the configured deployment', () => {
  it('falls back to cfg.deployment, and reads no catalog to do it', async () => {
    seed('m-default')
    const r = await draft('m-default', {})
    expect(r.status).toBe(200)
    expect(completions()[0].model).toBe(CONFIGURED)
    // The catalog is only consulted to validate a pick; the default path must
    // not pay two extra round trips on every draft.
    expect(outbound.filter((c) => c.url.endsWith('/models'))).toHaveLength(0)
  })
})

describe('AC-3 — an unknown deployment never reaches the provider', () => {
  it('answers 400 with zero completions', async () => {
    seed('m-bad')
    const r = await draft('m-bad', { model: 'not-a-deployment' })
    expect(r.status).toBe(400)
    expect(r.json.error).toBe('unknown model')
    expect(completions()).toHaveLength(0)
  })

  it('refuses a deployment that exists but is not chat-capable', async () => {
    seed('m-embed')
    const r = await draft('m-embed', { model: 'text-embedding-3-large' })
    expect(r.status).toBe(400)
    expect(completions()).toHaveLength(0)
  })
})

describe('AC-4 — the response says which deployment wrote the draft', () => {
  it('echoes usedModel for both the picked and the fallback case', async () => {
    seed('m-echo-1')
    expect((await draft('m-echo-1', { model: OTHER })).json.usedModel).toBe(OTHER)
    seed('m-echo-2')
    expect((await draft('m-echo-2', {})).json.usedModel).toBe(CONFIGURED)
  })
})
