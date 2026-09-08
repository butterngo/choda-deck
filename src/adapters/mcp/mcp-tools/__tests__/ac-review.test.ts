// TASK-1914 — the AC grader as a tool. No test reaches Foundry: the provider is
// an injected fetch, exactly as the HTTP route's own tests do it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { register } from '../ac-review'
import { REMOTE_TOOL_ALLOWLIST } from '../../server-bootstrap'

interface RegisteredTool {
  name: string
  meta: { description: string; inputSchema: Record<string, unknown> }
  handler: (args: { taskId: string; model?: string }) => Promise<{
    content: Array<{ type: 'text'; text: string }>
  }>
}

function makeServerStub(): {
  tools: RegisteredTool[]
  registerTool: (name: string, meta: RegisteredTool['meta'], handler: RegisteredTool['handler']) => void
} {
  const tools: RegisteredTool[] = []
  return {
    tools,
    registerTool: (name, meta, handler) => {
      tools.push({ name, meta, handler })
    }
  }
}

const BODY_THREE = [
  '## Context',
  'Not graded.',
  '',
  '## Acceptance',
  '- [ ] AC-1 — the first one, which names its surface',
  'This prose line is NOT a criterion and must not be graded.',
  '- [x] AC-2 — the second one, already ticked but still graded',
  '- [ ] AC-3 — the third one',
  '',
  '## Test Plan',
  '- [ ] not a criterion either — different section'
].join('\n')

const BODY_NONE = ['## Context', 'A task with nothing to grade.', '', '## Test Plan', 'none'].join('\n')

/** Provider calls made through the injected fetch, newest last. */
let providerCalls: { url: string; system: string; model: string }[] = []
let providerReply: () => Response
let dataDir: string

const fakeFetch = ((url: RequestInfo, init?: RequestInit): Promise<Response> => {
  const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
  const messages = (body.messages ?? []) as { role: string; content: unknown }[]
  const sys = messages.find((m) => m.role === 'system' || m.role === 'developer')
  providerCalls.push({
    url: String(url),
    system: typeof sys?.content === 'string' ? sys.content : '',
    model: typeof body.model === 'string' ? body.model : ''
  })
  return Promise.resolve(providerReply())
}) as unknown as typeof fetch

const ok = (criteria: unknown[]): Response =>
  new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify({ criteria }) } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )

const svc = {
  getTask: (id: string) =>
    Promise.resolve(
      id === 'TASK-NONE'
        ? { id, projectId: 'p', body: BODY_NONE }
        : id === 'TASK-MISSING'
          ? null
          : { id, projectId: 'p', body: BODY_THREE }
    )
} as unknown as Parameters<typeof register>[1]

function configureProvider(): void {
  writeFileSync(
    join(dataDir, 'ai-provider.json'),
    JSON.stringify({ provider: 'azure', endpoint: 'https://x.openai.azure.com/openai/v1', deployment: 'gpt-5' })
  )
  writeFileSync(join(dataDir, 'ai-key.txt'), 'secret-key')
}

async function call(
  args: { taskId: string; model?: string },
  withDataDir = true
): Promise<Record<string, unknown>> {
  const server = makeServerStub()
  register(server as never, svc, withDataDir ? dataDir : undefined, fakeFetch)
  const tool = server.tools.find((t) => t.name === 'ac_review')
  if (!tool) throw new Error('ac_review was not registered')
  const res = await tool.handler(args)
  return JSON.parse(res.content[0]?.text ?? '{}') as Record<string, unknown>
}

beforeEach(() => {
  providerCalls = []
  providerReply = () => ok([])
  dataDir = mkdtempSync(join(tmpdir(), 'choda-ac-review-tool-'))
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

describe('AC-1 — the tool is registered, and grades the checkbox lines only', () => {
  it('returns one row per criterion, and not one for the prose line', async () => {
    configureProvider()
    providerReply = () =>
      ok([
        { index: 0, verdict: 'ok', concern: null, suggestion: null },
        { index: 1, verdict: 'weak', concern: 'names no surface', suggestion: 'rewrite it' },
        { index: 2, verdict: 'ok', concern: null, suggestion: null }
      ])

    const out = await call({ taskId: 'TASK-A' })
    const criteria = out.criteria as Record<string, unknown>[]

    // THREE, not four: the prose line between them is not a criterion, and the
    // `- [ ]` under ## Test Plan belongs to a different section.
    expect(criteria).toHaveLength(3)
    expect(criteria.map((c) => c.index)).toEqual([0, 1, 2])
    expect(criteria[0]).toHaveProperty('text')
    expect(criteria[1].verdict).toBe('weak')
    expect(criteria[1].concern).toBe('names no surface')
    expect(criteria[1].suggestion).toBe('rewrite it')
  })

  it('takes an optional model, and it overrides the configured deployment', async () => {
    configureProvider()
    await call({ taskId: 'TASK-A', model: 'o4-mini' })
    // The deployment travels in the request BODY on this endpoint, not the url.
    expect(providerCalls[0]?.model).toBe('o4-mini')
  })

  it('CONTROL — omitting it uses the configured deployment', async () => {
    configureProvider()
    await call({ taskId: 'TASK-A' })
    expect(providerCalls[0]?.model).toBe('gpt-5')
  })

  it('an unknown task is named, and nothing is graded', async () => {
    configureProvider()
    const out = await call({ taskId: 'TASK-MISSING' })
    expect(out.error).toBe('TASK_NOT_FOUND')
    expect(providerCalls).toEqual([])
  })
})

describe('AC-2 — the tool and the HTTP route grade by the SAME standard', () => {
  it('sends a system prompt byte-identical to the route module\'s exported one', async () => {
    // Imported from the module the route also imports. If either caller ever
    // built its own prompt, this comparison is what fails.
    const { SYSTEM } = await import('../../../companion/ac-grader')
    configureProvider()
    await call({ taskId: 'TASK-A' })
    expect(providerCalls).toHaveLength(1)
    expect(providerCalls[0]?.system).toBe(SYSTEM)
  })
})

describe('AC-3 — a task with nothing to grade costs nothing', () => {
  it('says so, and makes ZERO provider calls', async () => {
    configureProvider()
    const out = await call({ taskId: 'TASK-NONE' })
    expect(out.error).toBe('NO_ACCEPTANCE_CRITERIA')
    // The whole point: not an empty criteria array, which reads as "nothing
    // flagged" — a claim about criteria this task does not have.
    expect(out.criteria).toBeUndefined()
    expect(providerCalls).toEqual([])
  })
})

describe('AC-4 — an unconfigured machine says so, and returns no verdicts', () => {
  it('answers NO_MODEL_CONFIGURED with no criteria array', async () => {
    // No ai-provider.json written.
    const out = await call({ taskId: 'TASK-A' })
    expect(out.error).toBe('NO_MODEL_CONFIGURED')
    expect(out.criteria).toBeUndefined()
    expect(providerCalls).toEqual([])
  })

  it('and the same when no dataDir is wired at all', async () => {
    const out = await call({ taskId: 'TASK-A' }, false)
    expect(out.error).toBe('NO_MODEL_CONFIGURED')
    expect(out.criteria).toBeUndefined()
  })
})

describe('AC-5 — a provider failure surfaces the kind, never the provider body', () => {
  it('reports the kind and leaks nothing from the provider message', async () => {
    configureProvider()
    providerReply = () =>
      new Response(JSON.stringify({ error: { message: 'invalid api key sk-live-abcdef123456' } }), {
        status: 401
      })

    const out = await call({ taskId: 'TASK-A' })

    expect(out.error).toBe('PROVIDER_FAILED')
    expect(out.kind).toBe('auth')
    // A reflected request can echo the key back; forwarding it is how a secret
    // reaches a log nobody thought was sensitive.
    expect(JSON.stringify(out)).not.toContain('sk-')
    expect(out.criteria).toBeUndefined()
  })

  it('a rate limit keeps its kind and its retry hint', async () => {
    configureProvider()
    providerReply = () =>
      new Response(JSON.stringify({ error: { message: 'slow down' } }), {
        status: 429,
        headers: { 'retry-after': '30' }
      })

    const out = await call({ taskId: 'TASK-A' })
    expect(out.kind).toBe('rate_limit')
    expect(out.retryAfter).toBe('30')
  })
})

describe('AC-6 — the tool is stdio-only', () => {
  it('is absent from REMOTE_TOOL_ALLOWLIST, while an allowlisted tool is present', async () => {
    expect(REMOTE_TOOL_ALLOWLIST.has('ac_review')).toBe(false)
    // The CONTROL: a set that contained nothing would satisfy the line above
    // while proving no policy at all.
    expect(REMOTE_TOOL_ALLOWLIST.has('task_list')).toBe(true)
  })

  it('but IS registered on a server with no allowlist — the stdio wiring', async () => {
    const server = makeServerStub()
    register(server as never, svc, dataDir, fakeFetch)
    expect(server.tools.map((t) => t.name)).toContain('ac_review')
  })
})
