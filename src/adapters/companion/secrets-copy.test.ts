import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Readable } from 'stream'
import type { IncomingMessage, ServerResponse } from 'http'
import { handleSecretsCopyRoute, type SecretsCopyLogEvent } from './secrets-copy'

// TASK-2607 — POST /secrets/copy. A temp workspace holds a FAKE
// sensitive_information/keys.txt (`a=1`, `b=2`); no real secret file is read.

const TOKEN = 'tok'
let tmp: string
let logged: SecretsCopyLogEvent[]

const svc = {
  getWorkspace: async (id: string) =>
    id === 'ws' ? { id: 'ws', projectId: 'p', label: 'WS', cwd: tmp, archivedAt: null } : null
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-copy-'))
  fs.mkdirSync(path.join(tmp, 'sensitive_information'))
  fs.writeFileSync(path.join(tmp, 'sensitive_information', 'keys.txt'), 'a=1\nb=2\n')
  fs.mkdirSync(path.join(tmp, 'docs'))
  fs.writeFileSync(path.join(tmp, 'docs', 'keys.txt'), 'b=9\n')
  logged = []
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tmp, { recursive: true, force: true })
})

interface Answer {
  status: number
  headers: Record<string, string>
  body: string
}

/** Drives the handler with an in-memory request, so the socket address is ours to set. */
async function post(
  body: unknown,
  { token = TOKEN, remoteAddress = '127.0.0.1' }: { token?: string | null; remoteAddress?: string } = {}
): Promise<Answer> {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    url: '/secrets/copy',
    method: 'POST',
    headers: token ? { 'x-choda-bridge-token': token } : {},
    socket: { remoteAddress }
  }) as unknown as IncomingMessage
  const answer: Answer = { status: 0, headers: {}, body: '' }
  const res = {
    writeHead: (status: number, headers: Record<string, string>) => {
      answer.status = status
      answer.headers = headers
    },
    end: (text: string) => {
      answer.body = text
    }
  } as unknown as ServerResponse
  expect(await handleSecretsCopyRoute(req, res, { bridgeToken: TOKEN, svc, log: (e) => logged.push(e) })).toBe(true)
  return answer
}

const ask = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  workspaceId: 'ws',
  file: 'sensitive_information/keys.txt',
  field: 'b',
  ...over
})

describe('POST /secrets/copy', () => {
  it('AC-3: a valid request for field b answers 200 { value: "2" }', async () => {
    const a = await post(ask())
    expect(a.status).toBe(200)
    expect(JSON.parse(a.body)).toEqual({ value: '2' })
  })

  it('AC-4: that response carries cache-control: no-store', async () => {
    expect((await post(ask())).headers['cache-control']).toBe('no-store')
  })

  it('AC-5: file ../package.json answers 400', async () => {
    expect((await post(ask({ file: '../package.json' }))).status).toBe(400)
  })

  it('AC-6: file docs/keys.txt answers 400', async () => {
    const a = await post(ask({ file: 'docs/keys.txt' }))
    expect(a.status).toBe(400)
    expect(a.body).toContain('sensitive_information/')
  })

  it('a traversal that comes back into the folder name is still refused', async () => {
    expect((await post(ask({ file: 'sensitive_information/../docs/keys.txt' }))).status).toBe(400)
  })

  it('AC-7: field c answers 404 naming c and no value', async () => {
    const a = await post(ask({ field: 'c' }))
    expect(a.status).toBe(404)
    expect(a.body).toContain('c')
    expect(a.body).not.toContain('1')
    expect(a.body).not.toContain('2')
  })

  it('a missing file answers 404 file not found', async () => {
    const a = await post(ask({ file: 'sensitive_information/none.txt' }))
    expect(a.status).toBe(404)
    expect(JSON.parse(a.body)).toEqual({ error: 'file not found' })
  })

  it('AC-8: a request without the token answers 401', async () => {
    expect((await post(ask(), { token: null })).status).toBe(401)
  })

  it('AC-9: a request whose socket address is not loopback answers 403', async () => {
    expect((await post(ask(), { remoteAddress: '10.0.0.5' })).status).toBe(403)
  })

  it('AC-10: neither the route log nor the console receives the value during the 200 request', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined)
    )
    const a = await post(ask())
    expect(a.status).toBe(200)
    expect(logged).toEqual([{ route: '/secrets/copy', status: 200, field: 'b' }])
    // The value "2" as a value: a serialised argument holding the string "2".
    // The status 200 is a number and the field is "b", so neither matches.
    const calls = [...logged.map((e) => [e]), ...spies.flatMap((s) => s.mock.calls)]
    for (const args of calls) expect(JSON.stringify(args)).not.toContain('"2"')
    expect(spies.every((s) => s.mock.calls.length === 0)).toBe(true)
  })
})
