// TASK-1566 — GET /artifacts/* . One test per acceptance criterion; the
// traversal cases assert both the status AND that no DB bytes came back, since a
// broken guard's tell is a 200 whose body starts with "SQLite format 3".

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as net from 'net'
import Database from 'better-sqlite3'
import { startCompanionServer, COMPANION_BIND, type CompanionServerHandle } from './http-server'
import type { CompanionServices } from './service-factory'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'

const TOKEN = 'artifacts-test-token'

// A real 1x1 PNG — byte-identity is part of the contract, so a hand-rolled
// buffer of zeros would not prove the stream is untouched.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

let dataDir: string
let artifactsDir: string
let handle: CompanionServerHandle
let base: string

const fakeSvc = {
  listProjects: async () => [],
  findTasks: async () => [],
  findInbox: async () => [],
  findConversations: async () => [],
  findWorkspaces: async () => []
} as unknown as BackendTaskService

function get(
  urlPath: string,
  headers: Record<string, string> = { 'x-choda-bridge-token': TOKEN }
): Promise<{ status: number; type: string | null; body: Buffer }> {
  return fetch(`${base}${urlPath}`, { headers }).then(async (r) => ({
    status: r.status,
    type: r.headers.get('content-type'),
    body: Buffer.from(await r.arrayBuffer())
  }))
}

/**
 * Send a request line VERBATIM over a socket, bypassing URL normalization.
 *
 * `fetch` (and curl without --path-as-is) collapse `../` and `%2e%2e` before the
 * bytes leave the client, so a traversal sent through them arrives as an
 * ordinary path and never reaches this route — the server would answer 404 and
 * the test would prove nothing about the guard. An attacker has no such
 * courtesy, so the guard is exercised the way it would actually be attacked.
 */
function rawGet(rawPath: string, token = TOKEN): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(handle.address.port, COMPANION_BIND, () => {
      sock.write(
        `GET ${rawPath} HTTP/1.1\r\nHost: ${COMPANION_BIND}\r\n` +
          `x-choda-bridge-token: ${token}\r\nConnection: close\r\n\r\n`
      )
    })
    const chunks: Buffer[] = []
    sock.on('data', (c: Buffer) => chunks.push(c))
    sock.on('error', reject)
    sock.on('end', () => {
      const raw = Buffer.concat(chunks)
      const status = Number.parseInt(raw.toString('latin1', 9, 12), 10)
      // Destroy explicitly: a lingering half-open socket keeps the worker's
      // event loop alive past afterAll and vitest kills the fork.
      sock.destroy()
      resolve({ status, body: raw.toString('latin1') })
    })
  })
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choda-artifacts-'))
  artifactsDir = path.join(dataDir, 'artifacts')
  const captures = path.join(artifactsDir, 'captures')
  fs.mkdirSync(captures, { recursive: true })
  fs.writeFileSync(path.join(captures, 'shot.png'), PNG_BYTES)
  fs.writeFileSync(path.join(captures, 'bundle.har'), '{"log":{}}', 'utf8')
  fs.writeFileSync(path.join(captures, 'tokens.design.json'), '{}', 'utf8')
  fs.writeFileSync(path.join(captures, 'note.md'), '# hi', 'utf8')
  fs.writeFileSync(path.join(captures, 'body.txt'), 'plain', 'utf8')
  fs.writeFileSync(path.join(captures, 'page.html'), '<p>x</p>', 'utf8')
  fs.writeFileSync(path.join(captures, 'page.css'), 'p{}', 'utf8')
  fs.writeFileSync(path.join(captures, 'shot.jpg'), PNG_BYTES)
  fs.writeFileSync(path.join(captures, 'shot.webp'), PNG_BYTES)
  // nested discovery session — proves multi-segment paths resolve
  const disc = path.join(captures, 'discovery-abc123')
  fs.mkdirSync(disc, { recursive: true })
  fs.writeFileSync(path.join(disc, 'timeline.jsonl'), '{"type":"nav"}\n', 'utf8')

  // a real SQLite file OUTSIDE the artifacts root — the traversal target
  const dbDir = path.join(dataDir, 'database')
  fs.mkdirSync(dbDir, { recursive: true })
  const db = new Database(path.join(dbDir, 'choda-deck.db'))
  db.exec('CREATE TABLE secrets (id TEXT)')
  db.close()

  const services = {
    svc: fakeSvc,
    db: null,
    dbPath: ':memory:',
    intervalMs: 30000,
    bridgeToken: TOKEN,
    artifactsDir,
    pull: async () => ({ upserted: 0, tombstoned: 0, cursor: 0 }),
    push: async () => ({ drained: 0, conflicts: 0, remaining: 0, reachable: true }),
    close: () => {}
  } as unknown as CompanionServices

  handle = await startCompanionServer(services, 0)
  base = `http://${COMPANION_BIND}:${handle.address.port}`
})

afterAll(async () => {
  await handle.close()
  // Windows holds a lock briefly after a served file's read stream closes, so a
  // bare rmSync here races the server teardown and throws EBUSY — which kills
  // the worker fork rather than failing a test. Retry, and never let cleanup of
  // a temp dir fail the run.
  try {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    /* temp dir; the OS reclaims it */
  }
})

describe('GET /artifacts/*', () => {
  it('AC-1: serves a png with the right type and byte-identical content', async () => {
    const r = await get('/artifacts/captures/shot.png')
    expect(r.status).toBe(200)
    expect(r.type).toBe('image/png')
    expect(r.body.equals(PNG_BYTES)).toBe(true)
  })

  it('AC-2: 401 without a token, and 401 with a wrong one — no file bytes either way', async () => {
    const none = await get('/artifacts/captures/shot.png', {})
    expect(none.status).toBe(401)
    expect(none.body.includes(PNG_BYTES.subarray(0, 8))).toBe(false)

    const wrong = await get('/artifacts/captures/shot.png', { 'x-choda-bridge-token': 'nope' })
    expect(wrong.status).toBe(401)
    expect(wrong.body.includes(PNG_BYTES.subarray(0, 8))).toBe(false)
  })

  it('AC-3: 403 on a literal ../ traversal, and no SQLite bytes leak', async () => {
    const r = await rawGet('/artifacts/../../database/choda-deck.db')
    expect(r.status).toBe(403)
    expect(r.body).not.toContain('SQLite format 3')
  })

  it('AC-4: 403 on a percent-encoded %2e%2e traversal', async () => {
    const r = await rawGet('/artifacts/%2e%2e/%2e%2e/database/choda-deck.db')
    expect(r.status).toBe(403)
    expect(r.body).not.toContain('SQLite format 3')
  })

  it('AC-4c: an unauthenticated raw traversal is refused before any path work', async () => {
    const r = await rawGet('/artifacts/../../database/choda-deck.db', 'wrong-token')
    expect(r.status).toBe(401)
    expect(r.body).not.toContain('SQLite format 3')
  })

  it('AC-4b: 403 on an encoded-slash traversal (the form URL parsing does NOT normalize)', async () => {
    const r = await get('/artifacts/..%2f..%2fdatabase/choda-deck.db')
    expect(r.status).toBe(403)
    expect(r.body.toString('utf8')).not.toContain('SQLite format 3')
  })

  it('AC-5: 404 JSON for a missing file inside the root, not a 500', async () => {
    const r = await get('/artifacts/captures/nope.png')
    expect(r.status).toBe(404)
    expect(r.type).toBe('application/json')
    expect(JSON.parse(r.body.toString('utf8')).error).toBeTruthy()
  })

  it('AC-5b: 404 for a directory, which is not a servable artifact', async () => {
    const r = await get('/artifacts/captures/discovery-abc123')
    expect(r.status).toBe(404)
  })

  it('AC-6: content-type is correct per extension', async () => {
    const cases: [string, string][] = [
      ['captures/shot.png', 'image/png'],
      ['captures/shot.jpg', 'image/jpeg'],
      ['captures/shot.webp', 'image/webp'],
      ['captures/bundle.har', 'application/json'],
      ['captures/tokens.design.json', 'application/json'],
      ['captures/discovery-abc123/timeline.jsonl', 'application/x-ndjson'],
      ['captures/note.md', 'text/markdown; charset=utf-8'],
      ['captures/body.txt', 'text/plain; charset=utf-8'],
      ['captures/page.html', 'text/html; charset=utf-8'],
      ['captures/page.css', 'text/css; charset=utf-8']
    ]
    for (const [rel, expected] of cases) {
      const r = await get(`/artifacts/${rel}`)
      expect(r.status, rel).toBe(200)
      expect(r.type, rel).toBe(expected)
    }
  })

  it('AC-7: serves a nested discovery-session file', async () => {
    const r = await get('/artifacts/captures/discovery-abc123/timeline.jsonl')
    expect(r.status).toBe(200)
    expect(r.body.toString('utf8')).toContain('"type":"nav"')
  })

  it('is GET-only: POST returns 405', async () => {
    const r = await fetch(`${base}/artifacts/captures/shot.png`, {
      method: 'POST',
      headers: { 'x-choda-bridge-token': TOKEN }
    })
    expect(r.status).toBe(405)
  })

  it('does not shadow the other routes', async () => {
    const r = await fetch(`${base}/healthz`)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true })
  })
})
