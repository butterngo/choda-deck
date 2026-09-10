// TASK-1935 — one test per acceptance criterion for the write half of
// /workspace-docs.
//
// Driven through a REAL server rather than fake req/res objects, because three
// of these criteria are about things a fake cannot have: a header the client
// actually sends, a body that actually streams, and a path that survives the
// wire without being normalised. The traversal case in particular is written
// raw over a socket — `fetch` collapses `../` before the bytes ever leave.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as net from 'net'
import { Buffer } from 'buffer'
import { createHash } from 'crypto'
import { startCompanionServer, COMPANION_BIND, type CompanionServerHandle } from './http-server'
import type { CompanionServices } from './service-factory'
import type { WorkspaceOperations } from '../../core/domain/interfaces/workspace-repository.interface'

const TOKEN = 'ws-docs-put-token'
const WS = 'main'

let root: string
let outside: string
let handle: CompanionServerHandle
let base: string

const hash = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
const onDisk = (rel: string): Buffer => fs.readFileSync(path.join(root, rel))

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-put-'))
  outside = path.join(path.dirname(root), 'secret-outside.md')
  fs.writeFileSync(outside, 'SECRET')

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
  fs.rmSync(outside, { force: true })
})

beforeEach(() => {
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(root, 'docs', 'guide.md'), '# guide\n\nbody\n')
  // The case that decides whether a save is honest: CRLF, with a BOM.
  fs.writeFileSync(
    path.join(root, 'docs', 'crlf-bom.md'),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# one\r\n\r\ntwo\r\n', 'utf8')])
  )
  fs.writeFileSync(path.join(root, 'docs', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]))
})

async function get(rel: string): Promise<{ status: number; etag: string | null; text: string }> {
  const res = await fetch(`${base}/workspace-docs/${WS}/${rel}`, {
    headers: { 'x-choda-bridge-token': TOKEN }
  })
  return { status: res.status, etag: res.headers.get('etag'), text: await res.text() }
}

async function put(
  rel: string,
  body: Buffer | string,
  ifMatch: string | null
): Promise<{ status: number; json: { sha256?: string; bytes?: number; error?: string } }> {
  const headers: Record<string, string> = { 'x-choda-bridge-token': TOKEN }
  if (ifMatch !== null) headers['if-match'] = ifMatch
  const res = await fetch(`${base}/workspace-docs/${WS}/${rel}`, { method: 'PUT', headers, body })
  return { status: res.status, json: (await res.json()) as { error?: string } }
}

// -----------------------------------------------------------------------------

describe('AC-8 — the GET hands back something the PUT will accept', () => {
  it('etag is the sha256 of the bytes on disk, and the PUT takes that exact value', async () => {
    const { etag } = await get('docs/guide.md')
    expect(etag).toBe(hash(onDisk('docs/guide.md')))

    const { status } = await put('docs/guide.md', '# edited\n', etag)
    expect(status).toBe(200)
  })
})

describe('AC-1 — a save with no precondition is refused', () => {
  it('returns 400 and the file is untouched', async () => {
    const before = hash(onDisk('docs/guide.md'))
    const { status, json } = await put('docs/guide.md', 'clobbered', null)
    expect(status).toBe(400)
    expect(json.error).toBe('if-match required')
    expect(hash(onDisk('docs/guide.md'))).toBe(before)
  })
})

describe('AC-2 — a stale precondition loses to the writer who got there first', () => {
  it('returns 409 and the other writer’s bytes survive', async () => {
    const stale = hash(onDisk('docs/guide.md'))
    // A second writer between the read and the save — the whole reason the
    // precondition exists.
    fs.writeFileSync(path.join(root, 'docs', 'guide.md'), 'written by someone else\n')

    const { status, json } = await put('docs/guide.md', 'my edit\n', stale)
    expect(status).toBe(409)
    expect(json.error).toBe('file changed on disk')
    expect(onDisk('docs/guide.md').toString()).toBe('written by someone else\n')
    // The response carries the CURRENT hash, so a client can re-read and retry
    // rather than guess.
    expect(json.sha256).toBe(hash(onDisk('docs/guide.md')))
  })

  it('CONTROL — the same save with a fresh hash succeeds', async () => {
    // Without this, a route that answered 409 unconditionally would pass above.
    const fresh = hash(onDisk('docs/guide.md'))
    const { status } = await put('docs/guide.md', 'my edit\n', fresh)
    expect(status).toBe(200)
    expect(onDisk('docs/guide.md').toString()).toBe('my edit\n')
  })
})

describe('AC-3 — a save changes only what the human changed', () => {
  it('a CRLF file with a BOM round-trips BYTE-IDENTICAL', async () => {
    const before = onDisk('docs/crlf-bom.md')

    // Read as BYTES, because `Response.text()` strips a leading BOM — a client
    // that decodes here would hand back a file it had already altered, and the
    // server would faithfully write the alteration.
    const res = await fetch(`${base}/workspace-docs/${WS}/docs/crlf-bom.md`, {
      headers: { 'x-choda-bridge-token': TOKEN }
    })
    const etag = res.headers.get('etag')
    const bytes = Buffer.from(await res.arrayBuffer())
    expect(Buffer.compare(bytes, before)).toBe(0)

    const { status } = await put('docs/crlf-bom.md', bytes, etag)
    expect(status).toBe(200)

    // Buffer comparison, not a string comparison: a string compare is exactly
    // what a normalising writer would still pass.
    expect(Buffer.compare(onDisk('docs/crlf-bom.md'), before)).toBe(0)
    expect(onDisk('docs/crlf-bom.md').subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
    expect(onDisk('docs/crlf-bom.md').includes(Buffer.from('\r\n'))).toBe(true)
  })
})

describe('AC-4 — a save cannot reach anywhere the read cannot', () => {
  it('a traversal sent RAW over a socket is refused and the outside file is untouched', async () => {
    const before = fs.readFileSync(outside)
    const status = await new Promise<number>((resolve, reject) => {
      const sock = net.connect(handle.address.port, COMPANION_BIND, () => {
        const body = 'OWNED'
        sock.write(
          `PUT /workspace-docs/${WS}/../secret-outside.md HTTP/1.1\r\n` +
            `Host: ${COMPANION_BIND}\r\n` +
            `x-choda-bridge-token: ${TOKEN}\r\n` +
            `if-match: ${hash(before)}\r\n` +
            `Content-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`
        )
      })
      const chunks: Buffer[] = []
      sock.on('data', (c: Buffer) => chunks.push(c))
      sock.on('error', reject)
      sock.on('end', () => {
        const raw = Buffer.concat(chunks).toString('latin1')
        sock.destroy()
        resolve(Number.parseInt(raw.slice(9, 12), 10))
      })
    })
    expect(status).toBeGreaterThanOrEqual(400)
    expect(Buffer.compare(fs.readFileSync(outside), before)).toBe(0)
    expect(fs.readFileSync(outside).toString()).toBe('SECRET')
  })
})

describe('AC-5 — saves never create', () => {
  it('a PUT to a path that does not exist is 404 and plants nothing', async () => {
    const target = path.join(root, 'docs', 'brand-new.md')
    const { status } = await put('docs/brand-new.md', 'hello', hash(Buffer.from('hello')))
    expect(status).toBe(404)
    expect(fs.existsSync(target)).toBe(false)
  })
})

describe('AC-6 — the size cap is a limit, not a wall', () => {
  it('one byte over is 413 and writes nothing', async () => {
    const before = hash(onDisk('docs/guide.md'))
    const etag = (await get('docs/guide.md')).etag
    const tooBig = Buffer.alloc(2 * 1024 * 1024 + 1, 0x61)
    const { status } = await put('docs/guide.md', tooBig, etag)
    expect(status).toBe(413)
    expect(hash(onDisk('docs/guide.md'))).toBe(before)
  })

  it('CONTROL — one byte under the cap succeeds', async () => {
    // Without this, a route that rejected every body would pass the test above.
    const etag = (await get('docs/guide.md')).etag
    const justUnder = Buffer.alloc(2 * 1024 * 1024 - 1, 0x62)
    const { status } = await put('docs/guide.md', justUnder, etag)
    expect(status).toBe(200)
    expect(onDisk('docs/guide.md').length).toBe(2 * 1024 * 1024 - 1)
  })
})

describe('AC-7 — the writer and the reader agree about binary', () => {
  it('a PUT to a binary path is 415 and writes nothing, matching the GET', async () => {
    const before = onDisk('docs/logo.png')
    const read = await get('docs/logo.png')
    expect(read.status).toBe(415)

    const { status } = await put('docs/logo.png', 'text now', hash(before))
    expect(status).toBe(415)
    expect(Buffer.compare(onDisk('docs/logo.png'), before)).toBe(0)
  })
})

describe('the guards the criteria imply', () => {
  it('a wrong token is refused before anything is read or written', async () => {
    const before = hash(onDisk('docs/guide.md'))
    const res = await fetch(`${base}/workspace-docs/${WS}/docs/guide.md`, {
      method: 'PUT',
      headers: { 'x-choda-bridge-token': 'wrong', 'if-match': before },
      body: 'nope'
    })
    expect(res.status).toBe(401)
    expect(hash(onDisk('docs/guide.md'))).toBe(before)
  })

  it('PUT on the LISTING route is 405 — a projection has nothing to write back to', async () => {
    const res = await fetch(`${base}/workspace-docs?workspaceId=${WS}`, {
      method: 'PUT',
      headers: { 'x-choda-bridge-token': TOKEN },
      body: '[]'
    })
    expect(res.status).toBe(405)
  })

  it('an unknown workspace is 404, not a write into nowhere', async () => {
    const res = await fetch(`${base}/workspace-docs/nope/docs/guide.md`, {
      method: 'PUT',
      headers: { 'x-choda-bridge-token': TOKEN, 'if-match': 'x' },
      body: 'hi'
    })
    expect(res.status).toBe(404)
  })
})
