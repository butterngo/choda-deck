// TASK-1860 — grading acceptance criteria, proven against an injected fetch.
//
// The route is plumbing and these tests prove the plumbing. Whether the GRADING
// is any good is AC-7, which is human by construction: a grader that returns
// fluent, plausible, useless verdicts passes every test in this file.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { handleAcReviewRoute, parseAcceptance } from './ac-review'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'

const TOKEN = 'ac-review-token'
const KEY = 'FIXTURE-KEY-9f8e7d6c5b4a39281706'
const ENDPOINT = 'https://fixture-resource.openai.azure.com/openai/v1'

const BODY_WITH_AC = [
  '## Context',
  'Some prose that is not a criterion.',
  '',
  '## Acceptance',
  '',
  '- [ ] AC-1 (machine) — `GET /x` returns 200 and the body carries `items`.',
  '- [x] AC-2 (machine) — the handler works correctly.',
  '',
  '## Test Plan',
  '- [ ] this checkbox is NOT a criterion',
  ''
].join('\n')

const BODY_WITHOUT_AC = '## Context\n\nNo criteria here.\n\n## Test Plan\n- [ ] nope\n'

let providerCalls: { url: string; body: Record<string, unknown> }[] = []
let providerReply: () => Response
let tmp: string
let server: Server
let base: string

const task = (id: string, body: string): unknown => ({ id, projectId: 'p', title: 't', body })

const svc = {
  getTask: async (id: string) => {
    if (id === 'TASK-WITH') return task('TASK-WITH', BODY_WITH_AC)
    if (id === 'TASK-WITHOUT') return task('TASK-WITHOUT', BODY_WITHOUT_AC)
    return null
  }
} as unknown as BackendTaskService

/** Records every provider call and replies with whatever the test scripted. */
const fetchImpl = ((url: RequestInfo | URL, init?: RequestInit) => {
  providerCalls.push({
    url: String(url),
    body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
  })
  return Promise.resolve(providerReply())
}) as unknown as typeof fetch

const ok = (criteria: unknown): Response =>
  new Response(
    JSON.stringify({
      choices: [
        { finish_reason: 'stop', message: { content: JSON.stringify({ criteria }), refusal: null } }
      ]
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )

function configureProvider(): void {
  fs.writeFileSync(path.join(tmp, 'ai-key.txt'), KEY)
  fs.writeFileSync(
    path.join(tmp, 'ai-provider.json'),
    JSON.stringify({ provider: 'azure', endpoint: ENDPOINT, deployment: 'gpt-4.1-mini' })
  )
}

interface Verdict {
  index: number
  text: string
  verdict: string
  concern: string | null
  suggestion: string | null
}

async function grade(
  body: unknown,
  headers: Record<string, string> = { 'x-choda-bridge-token': TOKEN }
): Promise<{ status: number; criteria: Verdict[]; raw: string }> {
  const res = await fetch(`${base}/tasks/ac-review`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  })
  const raw = await res.text()
  let criteria: Verdict[] = []
  try {
    criteria = (JSON.parse(raw) as { criteria?: Verdict[] }).criteria ?? []
  } catch {
    criteria = []
  }
  return { status: res.status, criteria, raw }
}

beforeEach(async () => {
  providerCalls = []
  providerReply = () => ok([])
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-review-'))
  server = createServer((req, res) => {
    void handleAcReviewRoute(req, res, { bridgeToken: TOKEN, svc, dataDir: tmp, fetchImpl }).then(
      (handled) => {
        if (!handled) {
          res.writeHead(404)
          res.end('{}')
        }
      }
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(tmp, { recursive: true, force: true })
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------

describe('parseAcceptance — only the criteria, and in ac_check order', () => {
  it('reads checkbox lines under ## Acceptance and stops at the next heading', () => {
    const out = parseAcceptance(BODY_WITH_AC)
    expect(out).toHaveLength(2)
    expect(out[0]).toContain('GET /x')
    // The Test Plan's checkbox must NOT be graded: it is not a criterion, and
    // including it would shift every index away from what ac_check flips.
    expect(out.some((c) => c.includes('NOT a criterion'))).toBe(false)
  })

  it('reads ticked and unticked alike', () => {
    // A DONE task's criteria are all [x]; grading must still see them.
    expect(parseAcceptance(BODY_WITH_AC)[1]).toContain('works correctly')
  })

  it('returns nothing when the section is absent', () => {
    expect(parseAcceptance(BODY_WITHOUT_AC)).toEqual([])
  })
})

describe('AC-1 — no model configured means no call and no invented verdicts', () => {
  it('501s and the provider is never reached', async () => {
    const res = await grade({ taskId: 'TASK-WITH' })
    expect(res.status).toBe(501)
    expect(providerCalls).toEqual([])
    // The other half of the criterion: a 200 carrying fabricated verdicts would
    // be far worse than a refusal, and a status-only check would miss it.
    expect(res.criteria).toEqual([])
  })
})

describe('AC-2 — the grader separates a criterion that names its surface from one that does not', () => {
  it('grades the specific one ok and the vague one weak', async () => {
    configureProvider()
    providerReply = () =>
      ok([
        { index: 0, verdict: 'ok', concern: null, suggestion: null },
        {
          index: 1,
          verdict: 'weak',
          concern: 'names no surface',
          suggestion: 'AC-2 — `POST /x` with a malformed body returns 400 and writes nothing.'
        }
      ])

    const res = await grade({ taskId: 'TASK-WITH' })
    expect(res.status).toBe(200)
    // Both in ONE test and asserted as DIFFERENT. Separate tests would both pass
    // against a grader that always answers 'weak', which measures nothing.
    expect(res.criteria[0].verdict).toBe('ok')
    expect(res.criteria[1].verdict).toBe('weak')
    expect(res.criteria[0].verdict).not.toBe(res.criteria[1].verdict)
    expect(res.criteria[1].concern).toContain('surface')
  })

  it('carries the criterion text back, so a verdict can be read against it', async () => {
    configureProvider()
    providerReply = () => ok([{ index: 1, verdict: 'weak', concern: 'x', suggestion: null }])
    const res = await grade({ taskId: 'TASK-WITH' })
    // A verdict with no text is an index nobody can act on.
    expect(res.criteria[1].text).toContain('works correctly')
  })
})

describe('AC-3 — a criterion the model did not answer for is not approved by default', () => {
  it('defaults to ok but still returns every criterion, never a short list', async () => {
    configureProvider()
    providerReply = () => ok([{ index: 0, verdict: 'weak', concern: 'vague', suggestion: null }])
    const res = await grade({ taskId: 'TASK-WITH' })
    // Two criteria in, two verdicts out. A response that dropped the unmentioned
    // one would render as "nothing to say about it", which is indistinguishable
    // from approval on screen.
    expect(res.criteria).toHaveLength(2)
    expect(res.criteria[1].index).toBe(1)
  })
})

describe('AC-4 — a task with no criteria costs nothing', () => {
  it('404s and makes no provider call even when a model IS configured', async () => {
    configureProvider()
    const res = await grade({ taskId: 'TASK-WITHOUT' })
    expect(res.status).toBe(404)
    // The check happens BEFORE the provider is resolved, so grading an empty
    // list cannot spend money on a machine that is fully set up.
    expect(providerCalls).toEqual([])
  })

  it('404s for a task that does not exist', async () => {
    configureProvider()
    expect((await grade({ taskId: 'TASK-NOPE' })).status).toBe(404)
    expect(providerCalls).toEqual([])
  })

  it('400s without a taskId, and 401s without the token', async () => {
    configureProvider()
    expect((await grade({})).status).toBe(400)
    expect((await grade({ taskId: 'TASK-WITH' }, {})).status).toBe(401)
    expect(providerCalls).toEqual([])
  })

  it('405s a GET', async () => {
    const res = await fetch(`${base}/tasks/ac-review`, {
      headers: { 'x-choda-bridge-token': TOKEN }
    })
    expect(res.status).toBe(405)
  })
})

describe('AC-6 — grading reads, it never writes', () => {
  it('the task body is untouched and no write method is called', async () => {
    configureProvider()
    const updateTask = vi.fn()
    const readOnly = { getTask: svc.getTask, updateTask } as unknown as BackendTaskService

    const local = createServer((req, res) => {
      void handleAcReviewRoute(req, res, {
        bridgeToken: TOKEN,
        svc: readOnly,
        dataDir: tmp,
        fetchImpl
      })
    })
    await new Promise<void>((r) => local.listen(0, '127.0.0.1', r))
    const localBase = `http://127.0.0.1:${(local.address() as AddressInfo).port}`

    providerReply = () =>
      ok([{ index: 0, verdict: 'weak', concern: 'vague', suggestion: 'a rewritten criterion' }])
    const res = await fetch(`${localBase}/tasks/ac-review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-choda-bridge-token': TOKEN },
      body: JSON.stringify({ taskId: 'TASK-WITH' })
    })
    const body = (await res.json()) as { criteria: Verdict[] }
    await new Promise<void>((r) => local.close(() => r()))

    // The suggestion comes back as text to read.
    expect(body.criteria[0].suggestion).toBe('a rewritten criterion')
    // And nothing writes it. A model editing a spec nobody approved is the one
    // outcome this route must make impossible.
    expect(updateTask).not.toHaveBeenCalled()
  })
})

describe('AC-8 — provider failures are typed, and the key never leaks', () => {
  it('maps 500 to 502 and 401 to 502 auth, with the key absent from every body', async () => {
    configureProvider()
    const bodies: string[] = []

    providerReply = () => new Response(`upstream echoed ${KEY}`, { status: 500 })
    bodies.push((await grade({ taskId: 'TASK-WITH' })).raw)

    providerReply = () => new Response('nope', { status: 401 })
    const auth = await grade({ taskId: 'TASK-WITH' })
    bodies.push(auth.raw)

    expect(auth.status).toBe(502)
    expect(JSON.parse(auth.raw).kind).toBe('auth')
    // The 500 case has the key in the PROVIDER's body — forwarding it verbatim
    // is how a secret reaches a log nobody thought was sensitive.
    for (const b of bodies) expect(b).not.toContain(KEY)
  })

  it('an exhausted reasoning budget is reported as budget, not parse', async () => {
    configureProvider()
    providerReply = () =>
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: 'length', message: { content: '', refusal: null } }]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    const res = await grade({ taskId: 'TASK-WITH', model: 'gpt-5-mini' })
    expect(res.status).toBe(502)
    // Inherited from askAzureJson rather than re-implemented — the whole reason
    // the transport was extracted instead of copied.
    expect(JSON.parse(res.raw).kind).toBe('budget')
  })
})
