// TASK-1856 — the Azure provider, proven against an injected fetch that records
// every call. Each test names what a BROKEN implementation would produce, since
// a criterion whose pass and fail look alike proves nothing.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { AiError } from './ai-review'
import {
  resolveAzureConfig,
  listAzureModels,
  reviewFileAzure,
  isReasoningDeployment,
  type AzureConfig
} from './azure-review'

const ENDPOINT = 'https://example-resource.openai.azure.com/openai/v1'
const KEY = 'FIXTURE-KEY-e3b0c44298fc1c149afbf4c8996fb924'
const CFG: AzureConfig = { endpoint: ENDPOINT, deployment: 'gpt-4.1-mini', key: KEY }

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: Record<string, unknown> | null
}

let calls: Call[] = []

/** Records every request and replies with whatever the test scripted. */
function stubFetch(reply: (url: string) => Response): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null
    })
    return Promise.resolve(reply(url))
  }) as typeof fetch
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

/** A well-formed chat answer carrying one note. */
const chatOk = (content = '{"notes":[{"checkId":"trigger","message":"vague","quote":null}]}') =>
  json({ choices: [{ finish_reason: 'stop', message: { content, refusal: null } }] })

let tmp: string

beforeEach(() => {
  calls = []
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'azure-review-'))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function writeConfig(cfg: Record<string, unknown>, key: string | null = KEY): void {
  fs.writeFileSync(path.join(tmp, 'ai-provider.json'), JSON.stringify(cfg))
  if (key !== null) fs.writeFileSync(path.join(tmp, 'ai-key.txt'), key)
}

// ---------------------------------------------------------------------------

describe('AC-1 — the request goes to Azure and nowhere else', () => {
  it('posts to {endpoint}/chat/completions with api-key and no anthropic headers', async () => {
    await reviewFileAzure({ cfg: CFG, rel: 'SKILL.md', text: 'x', fetchImpl: stubFetch(() => chatOk()) })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${ENDPOINT}/chat/completions`)
    expect(calls[0].method).toBe('POST')
    expect(calls[0].headers['api-key']).toBe(KEY)
    // Asserted as ABSENT, not merely "api-key is present" — sending both auth
    // shapes would satisfy a presence check while leaking the key to a second
    // vendor's header convention.
    expect(calls[0].headers['x-api-key']).toBeUndefined()
    expect(calls[0].headers['anthropic-version']).toBeUndefined()
    // The whole point of the task: nothing reaches Anthropic.
    expect(calls.some((c) => c.url.includes('anthropic.com'))).toBe(false)
  })

  it('sends the system prompt as a message, not a top-level field', async () => {
    await reviewFileAzure({ cfg: CFG, rel: 'SKILL.md', text: 'x', fetchImpl: stubFetch(() => chatOk()) })
    const body = calls[0].body as { system?: unknown; messages: { role: string }[] }
    // Anthropic's shape would be accepted by a stub and 400 against the real API.
    expect(body.system).toBeUndefined()
    expect(body.messages.map((m) => m.role)).toEqual(['system', 'user'])
  })
})

describe('AC-2 — nothing configured means nothing is spent', () => {
  it('returns null when no provider file exists', () => {
    expect(resolveAzureConfig(tmp)).toBeNull()
  })

  it('returns null when the provider is not azure', () => {
    writeConfig({ provider: 'anthropic' })
    expect(resolveAzureConfig(tmp)).toBeNull()
  })

  it('returns null when the key file is absent or empty', () => {
    writeConfig({ provider: 'azure', endpoint: ENDPOINT, deployment: 'gpt-4o' }, null)
    expect(resolveAzureConfig(tmp)).toBeNull()

    fs.writeFileSync(path.join(tmp, 'ai-key.txt'), '   ')
    expect(resolveAzureConfig(tmp)).toBeNull()
  })

  it('CONTROL — a complete config resolves, so the nulls above mean something', () => {
    // Without this, every assertion in this block is satisfied by a function
    // that returns null unconditionally.
    writeConfig({ provider: 'azure', endpoint: ENDPOINT, deployment: 'gpt-4o' })
    expect(resolveAzureConfig(tmp)).toEqual({ endpoint: ENDPOINT, deployment: 'gpt-4o', key: KEY })
  })

  it('a malformed config throws rather than reading as unconfigured', () => {
    fs.writeFileSync(path.join(tmp, 'ai-provider.json'), '{not json')
    // Degrading to null here would answer 501 "no model configured" to someone
    // who configured one, and send them looking for a key they already set.
    expect(() => resolveAzureConfig(tmp)).toThrow(AiError)
  })
})

describe('AC-3 — the token field follows the deployment family', () => {
  it('sends max_tokens for a non-reasoning deployment', async () => {
    await reviewFileAzure({ cfg: CFG, rel: 'a', text: 'x', fetchImpl: stubFetch(() => chatOk()) })
    expect(calls[0].body).toHaveProperty('max_tokens')
    expect(calls[0].body).not.toHaveProperty('max_completion_tokens')
  })

  it('sends max_completion_tokens for a reasoning deployment', async () => {
    await reviewFileAzure({
      cfg: CFG,
      rel: 'a',
      text: 'x',
      model: 'gpt-5-mini',
      fetchImpl: stubFetch(() => chatOk())
    })
    // Measured: gpt-5-mini rejects max_tokens outright with a 400.
    expect(calls[0].body).toHaveProperty('max_completion_tokens')
    expect(calls[0].body).not.toHaveProperty('max_tokens')
  })

  it('gives the reasoning deployment a strictly larger budget', async () => {
    const stub = stubFetch(() => chatOk())
    await reviewFileAzure({ cfg: CFG, rel: 'a', text: 'x', fetchImpl: stub })
    await reviewFileAzure({ cfg: CFG, rel: 'a', text: 'x', model: 'gpt-5-mini', fetchImpl: stub })
    const plain = calls[0].body as { max_tokens: number }
    const reason = calls[1].body as { max_completion_tokens: number }
    // Same number in both would reproduce the empty-answer bug AC-4 describes.
    expect(reason.max_completion_tokens).toBeGreaterThan(plain.max_tokens)
  })

  it('recognises a reasoning family by prefix, not exact id', () => {
    // A deployment is named by whoever created it.
    expect(isReasoningDeployment('gpt-5-mini-prod')).toBe(true)
    expect(isReasoningDeployment('o3-review')).toBe(true)
    expect(isReasoningDeployment('gpt-4.1-mini')).toBe(false)
  })
})

describe('AC-4 — an exhausted budget is its own fact', () => {
  it('reports budget, not parse, on a 200 with empty content and finish_reason length', async () => {
    const stub = stubFetch(() =>
      json({ choices: [{ finish_reason: 'length', message: { content: '', refusal: null } }] })
    )
    const err = await reviewFileAzure({
      cfg: CFG,
      rel: 'a',
      text: 'x',
      model: 'gpt-5-mini',
      fetchImpl: stub
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(AiError)
    // The distinction IS the criterion: 'parse' tells the reader the model
    // answered badly. It did not answer at all, and the fix is a number.
    expect((err as AiError).kind).toBe('budget')
    expect((err as AiError).kind).not.toBe('parse')
  })

  it('CONTROL — genuinely malformed content still reports parse', async () => {
    // Otherwise "budget" could be returned for every failure and pass above.
    const stub = stubFetch(() =>
      json({ choices: [{ finish_reason: 'stop', message: { content: 'not json', refusal: null } }] })
    )
    const err = await reviewFileAzure({ cfg: CFG, rel: 'a', text: 'x', fetchImpl: stub }).catch(
      (e: unknown) => e
    )
    expect((err as AiError).kind).toBe('parse')
  })

  it('a refusal is reported as a refusal', async () => {
    const stub = stubFetch(() =>
      json({ choices: [{ finish_reason: 'stop', message: { content: null, refusal: 'no' } }] })
    )
    const err = await reviewFileAzure({ cfg: CFG, rel: 'a', text: 'x', fetchImpl: stub }).catch(
      (e: unknown) => e
    )
    expect((err as AiError).kind).toBe('refusal')
  })
})

describe('AC-5 — the picker is offered only what can actually answer', () => {
  const deployments = {
    data: [
      { id: 'gpt-4.1-mini', model: 'gpt-4.1-mini', status: 'succeeded' },
      { id: 'gpt-5-mini', model: 'gpt-5-mini', status: 'succeeded' },
      { id: 'text-embedding-3-large', model: 'text-embedding-3-large', status: 'succeeded' },
      { id: 'gpt-4o-halfbuilt', model: 'gpt-4o', status: 'creating' }
    ]
  }
  const catalog = {
    data: [
      { id: 'gpt-4.1-mini', capabilities: { chat_completion: true, embeddings: false } },
      { id: 'gpt-5-mini', capabilities: { chat_completion: true, embeddings: false } },
      { id: 'text-embedding-3-large', capabilities: { chat_completion: false, embeddings: true } },
      { id: 'gpt-4o', capabilities: { chat_completion: true, embeddings: false } }
    ]
  }
  const stub = () =>
    stubFetch((url) => (url.includes('/deployments') ? json(deployments) : json(catalog)))

  it('excludes embedding deployments and anything not succeeded', async () => {
    const models = await listAzureModels(CFG, stub())
    expect(models.map((m) => m.id)).toEqual(['gpt-4.1-mini', 'gpt-5-mini'])
    // Offering an embedding deployment produces a 404 the moment it is picked.
    expect(models.some((m) => m.id.startsWith('text-embedding'))).toBe(false)
    // And a half-built one produces a failure that looks like a bug in us.
    expect(models.some((m) => m.id === 'gpt-4o-halfbuilt')).toBe(false)
  })

  it('reads the deployments route, not the region catalog, for the list', async () => {
    await listAzureModels(CFG, stub())
    const listing = calls.find((c) => c.url.includes('/deployments'))
    expect(listing).toBeDefined()
    // Measured: only this api-version answers on that route; the one the chat
    // calls use returns 404, which reads like a wrong URL.
    expect(listing?.url).toContain('api-version=2023-03-15-preview')
  })

  it('the capability filter is a join, not a name prefix', async () => {
    // A chat model that breaks the naming convention must still be offered.
    const odd = stubFetch((url) =>
      url.includes('/deployments')
        ? json({ data: [{ id: 'text-oracle', model: 'text-oracle', status: 'succeeded' }] })
        : json({ data: [{ id: 'text-oracle', capabilities: { chat_completion: true } }] })
    )
    const models = await listAzureModels(CFG, odd)
    // A `text-` prefix rule would drop this, silently hiding a usable model.
    expect(models.map((m) => m.id)).toEqual(['text-oracle'])
  })
})

describe('AC-6 — a listing outage does not disable review', () => {
  it('listing failure throws, and review still works afterwards', async () => {
    const failing = stubFetch((url) =>
      url.includes('/deployments') ? json({ error: 'boom' }, 503) : json({ data: [] })
    )
    await expect(listAzureModels(CFG, failing)).rejects.toBeInstanceOf(AiError)

    // The point: review does not depend on the listing having succeeded. The
    // picker is a convenience; making it load-bearing would let an Azure
    // control-plane blip take out a feature that never needed it.
    const notes = await reviewFileAzure({
      cfg: CFG,
      rel: 'a',
      text: 'x',
      fetchImpl: stubFetch(() => chatOk())
    })
    expect(notes).toHaveLength(1)
  })
})

describe('AC-7 — the picked model is the model that is asked', () => {
  it('uses the override, not the configured default', async () => {
    await reviewFileAzure({
      cfg: CFG,
      rel: 'a',
      text: 'x',
      model: 'gpt-4o',
      fetchImpl: stubFetch(() => chatOk())
    })
    expect((calls[0].body as { model: string }).model).toBe('gpt-4o')
    // CFG.deployment is gpt-4.1-mini — a picker that renders but sends the
    // default is a control that lies about what it did.
    expect((calls[0].body as { model: string }).model).not.toBe(CFG.deployment)
  })

  it('falls back to the configured deployment when nothing is picked', async () => {
    await reviewFileAzure({ cfg: CFG, rel: 'a', text: 'x', fetchImpl: stubFetch(() => chatOk()) })
    expect((calls[0].body as { model: string }).model).toBe('gpt-4.1-mini')
  })
})

describe('AC-8 — the key stays out of everything a reader can see', () => {
  it('never appears in an error message across auth, rate-limit, api and network paths', async () => {
    const statuses: [number, string][] = [
      [401, 'auth'],
      [429, 'rate_limit'],
      [500, 'api']
    ]
    for (const [status, kind] of statuses) {
      const err = await reviewFileAzure({
        cfg: CFG,
        rel: 'a',
        text: 'x',
        fetchImpl: stubFetch(() => json({ error: 'x' }, status))
      }).catch((e: unknown) => e)
      expect((err as AiError).kind).toBe(kind)
      expect((err as AiError).message).not.toContain(KEY)
    }

    const thrown = await reviewFileAzure({
      cfg: CFG,
      rel: 'a',
      text: 'x',
      fetchImpl: (() => Promise.reject(new Error(`connect failed to ${ENDPOINT}`))) as typeof fetch
    }).catch((e: unknown) => e)
    expect((thrown as AiError).kind).toBe('network')
    expect((thrown as AiError).message).not.toContain(KEY)
  })

  it('the listing failure message carries neither key nor endpoint', async () => {
    const err = await listAzureModels(
      CFG,
      stubFetch(() => json({ error: 'x' }, 503))
    ).catch((e: unknown) => e)
    expect((err as AiError).message).not.toContain(KEY)
    // The endpoint names the customer's resource; a message pasted into an
    // issue should not carry it.
    expect((err as AiError).message).not.toContain('example-resource')
  })
})
