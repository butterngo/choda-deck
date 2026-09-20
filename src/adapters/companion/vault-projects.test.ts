// TASK-2048 — GET /vault/projects/:id.
//
// The load-bearing tests are the scoping ones, and they follow vault.test.ts's
// discipline exactly: a marker is planted in 20-Areas and every refusal asserts
// BOTH the status AND that the marker never came back. Asserting only the status
// would pass against a guard that refuses the wrong paths and serves the right
// ones.
//
// Traversals go over a raw socket. `fetch` collapses `../` and `%2e%2e` before
// the bytes leave the client, so a traversal sent through it arrives as an
// ordinary path and never reaches the guard — the test would prove nothing.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as net from 'net'
import { startCompanionServer, COMPANION_BIND, type CompanionServerHandle } from './http-server'
import type { CompanionServices } from './service-factory'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'
import { readProjectVault, type ProjectVault } from './vault-projects'

const TOKEN = 'vault-projects-test-token'

/** Planted in 20-Areas. Its presence in any body means the scoping failed. */
const PRIVATE_MARKER = 'BUTTER_PRIVATE_PREFERENCES_DO_NOT_SERVE'

let vaultDir: string
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
): Promise<{ status: number; text: string; json: Partial<ProjectVault> }> {
  return fetch(`${base}${urlPath}`, { headers }).then(async (r) => {
    const text = await r.text();
    let json: Partial<ProjectVault> = {}
    try {
      json = JSON.parse(text) as Partial<ProjectVault>
    } catch {
      /* not JSON — the text assertion still runs */
    }
    return { status: r.status, text, json }
  })
}

function send(
  method: string,
  urlPath: string
): Promise<{ status: number; text: string }> {
  return fetch(`${base}${urlPath}`, {
    method,
    headers: { 'x-choda-bridge-token': TOKEN }
  }).then(async (r) => ({ status: r.status, text: await r.text() }))
}

/** A request line sent VERBATIM, bypassing the client's URL normalization. */
function rawGet(rawPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(handle.address.port, COMPANION_BIND, () => {
      sock.write(
        `GET ${rawPath} HTTP/1.1\r\nHost: ${COMPANION_BIND}\r\n` +
          `x-choda-bridge-token: ${TOKEN}\r\nConnection: close\r\n\r\n`
      )
    })
    const chunks: Buffer[] = []
    sock.on('data', (c: Buffer) => chunks.push(c))
    sock.on('error', reject)
    sock.on('end', () => {
      const raw = Buffer.concat(chunks)
      const status = Number.parseInt(raw.toString('latin1', 9, 12), 10)
      sock.destroy()
      resolve({ status, body: raw.toString('latin1') })
    })
  })
}

function projectsRoot(): string {
  return path.join(vaultDir, '10-Projects')
}

beforeAll(async () => {
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choda-vault-projects-'))

  // The three shapes that exist on Butter's disk today.

  // 1. meetings, no context.md — juvenis-maxime
  const jm = path.join(projectsRoot(), 'juvenis-maxime', 'meetings')
  fs.mkdirSync(path.join(jm, '2026-09-17-chi-kate-v3'), { recursive: true })
  fs.writeFileSync(path.join(jm, '2026-09-17-chi-kate-v3', 'note.md'), 'a'.repeat(120), 'utf8')
  fs.writeFileSync(path.join(jm, '2026-09-17-chi-kate-v3', 'transcript.md'), 'b'.repeat(240), 'utf8')
  fs.mkdirSync(path.join(jm, '2026-09-20-kate'), { recursive: true })
  fs.writeFileSync(path.join(jm, '2026-09-20-kate', 'note.md'), 'c'.repeat(60), 'utf8')
  fs.writeFileSync(path.join(jm, '2026-09-20-kate', 'transcript.md'), 'd'.repeat(80), 'utf8')

  // 2. a meeting with a transcript and NO note — headless-cms/2026-09-19-lex
  const hc = path.join(projectsRoot(), 'headless-cms', 'meetings', '2026-09-19-lex')
  fs.mkdirSync(hc, { recursive: true })
  fs.writeFileSync(path.join(hc, 'transcript.md'), 'e'.repeat(300), 'utf8')

  // 3. a folder with context.md and no meetings at all — choda-deck
  fs.mkdirSync(path.join(projectsRoot(), 'choda-deck'), { recursive: true })
  fs.writeFileSync(path.join(projectsRoot(), 'choda-deck', 'context.md'), '# ctx\n', 'utf8')

  // 4. a hand-made folder whose name carries no date
  fs.mkdirSync(path.join(projectsRoot(), 'mantu', 'meetings', 'notes-from-tuesday'), {
    recursive: true
  })

  // The OTHER root, seeded so AC-4 can prove it still works rather than
  // proving only that a missing folder 404s.
  const notes = path.join(vaultDir, '30-Knowledge')
  fs.mkdirSync(notes, { recursive: true })
  fs.writeFileSync(path.join(notes, 'a-note.md'), '# a note', 'utf8')

  // OUTSIDE the served root — the scoping target.
  const areas = path.join(vaultDir, '20-Areas')
  fs.mkdirSync(areas, { recursive: true })
  fs.writeFileSync(path.join(areas, 'preferences.md'), PRIVATE_MARKER, 'utf8')

  // Also outside it, one level up from 10-Projects but inside the vault.
  fs.writeFileSync(path.join(vaultDir, 'dashboard.md'), PRIVATE_MARKER, 'utf8')

  const services = {
    svc: fakeSvc,
    db: null,
    dbPath: ':memory:',
    intervalMs: 30000,
    bridgeToken: TOKEN,
    vaultDir,
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
    fs.rmSync(vaultDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    /* temp dir; the OS reclaims it */
  }
})

describe('GET /vault/projects/:id', () => {
  // AC-1
  it('reports the folder, its context note and its meetings with per-file presence', async () => {
    const r = await get('/vault/projects/juvenis-maxime')
    expect(r.status).toBe(200)
    expect(r.json.exists).toBe(true)
    expect(r.json.contextFile).toBe(false)
    expect(r.json.relativePath).toBe('vault/10-Projects/juvenis-maxime')

    const meetings = r.json.meetings ?? []
    expect(meetings.map((m) => m.folder)).toEqual(['2026-09-20-kate', '2026-09-17-chi-kate-v3'])

    const v3 = meetings.find((m) => m.folder === '2026-09-17-chi-kate-v3')
    expect(v3?.date).toBe('2026-09-17')
    expect(v3?.slug).toBe('chi-kate-v3')
    expect(v3?.files).toEqual([
      { name: 'note.md', present: true, bytes: 120 },
      { name: 'transcript.md', present: true, bytes: 240 }
    ])
  })

  // AC-1 — the shape already on disk that nothing reports today
  it('reports a meeting whose note was never saved as a missing file, not a dropped row', async () => {
    const r = await get('/vault/projects/headless-cms')
    const lex = (r.json.meetings ?? []).find((m) => m.folder === '2026-09-19-lex')
    expect(lex).toBeDefined()
    expect(lex?.files).toEqual([
      { name: 'note.md', present: false, bytes: null },
      { name: 'transcript.md', present: true, bytes: 300 }
    ])
  })

  // AC-2 — the discriminating pair
  it('tells "no folder" apart from "a folder with no meetings"', async () => {
    const missing = await get('/vault/projects/english-companion')
    const empty = await get('/vault/projects/choda-deck')

    expect(missing.status).toBe(200)
    expect(empty.status).toBe(200)

    expect(missing.json.exists).toBe(false)
    expect(empty.json.exists).toBe(true)
    // Both have zero meetings — so the meetings list alone cannot distinguish
    // them, which is exactly why `exists` has to carry the difference.
    expect(missing.json.meetings).toEqual([])
    expect(empty.json.meetings).toEqual([])
    expect(missing.json).not.toEqual(empty.json)
    // The path that WOULD be created is reported either way.
    expect(missing.json.relativePath).toBe('vault/10-Projects/english-companion')
  })

  it('reports context.md present and absent, and they differ', async () => {
    expect((await get('/vault/projects/choda-deck')).json.contextFile).toBe(true)
    expect((await get('/vault/projects/juvenis-maxime')).json.contextFile).toBe(false)
  })

  // AC-8
  it('lists a hand-made folder whose name carries no date, with date null', async () => {
    const r = await get('/vault/projects/mantu')
    const odd = (r.json.meetings ?? []).find((m) => m.folder === 'notes-from-tuesday')
    expect(odd).toBeDefined()
    expect(odd?.date).toBeNull()
    expect(odd?.slug).toBeNull()
    // "date unknown" is not "not a meeting" — the files are still reported.
    expect(odd?.files.map((f) => f.name)).toEqual(['note.md', 'transcript.md'])
  })

  it('never returns file contents, only names and sizes', async () => {
    const r = await get('/vault/projects/juvenis-maxime')
    // The fixture files are runs of one letter; none of that may appear.
    expect(r.text).not.toContain('aaaaaaaaaa')
    expect(r.text).not.toContain('bbbbbbbbbb')
  })
})

describe('the sandbox', () => {
  // AC-3 / AC-5 — every case asserts the marker never came back
  it.each([
    ['/vault/projects/..', 'bare dot-dot'],
    ['/vault/projects/../20-Areas', 'traversal to 20-Areas'],
    ['/vault/projects/%2e%2e/20-Areas', 'encoded traversal'],
    ['/vault/projects/..%2F..%2F20-Areas', 'encoded separators'],
    ['/vault/projects/....//20-Areas', 'doubled dots'],
    ['/vault/projects/C:/Windows', 'drive letter'],
    ['/vault/projects//etc/passwd', 'absolute path'],
    ['/vault/projects/juvenis-maxime/../../20-Areas', 'traversal out of a real project'],
    ['/vault/projects/.', 'single dot'],
    ['/vault/projects/', 'empty id']
  ])('refuses %s (%s) and leaks nothing', async (rawPath) => {
    const r = await rawGet(rawPath)
    expect(r.status).toBeGreaterThanOrEqual(400)
    expect(r.status).toBeLessThan(500)
    // The tell of a broken guard is a 200 carrying the marker — but assert it
    // on every response regardless of status.
    expect(r.body).not.toContain(PRIVATE_MARKER)
  })

  // AC-5 — its own test, with the real file seeded
  it('cannot reach 20-Areas by any input these tests can construct', async () => {
    const attempts = [
      '/vault/projects/20-Areas',
      '/vault/projects/..%5C20-Areas',
      '/vault/projects/%2E%2E%2F20-Areas',
      '/vault/projects/juvenis-maxime%2F..%2F..%2F20-Areas'
    ]
    for (const a of attempts) {
      const r = await rawGet(a)
      expect(r.body).not.toContain(PRIVATE_MARKER)
    }
    // And the sibling file one level above the root is equally unreachable.
    expect((await rawGet('/vault/projects/../dashboard.md')).body).not.toContain(PRIVATE_MARKER)
  })

  // The subtler half, and the one an injection run exposed: "20-Areas" is a
  // VALID project id by the alphabet, so a widened root would not need a
  // traversal to reach it — the route would simply answer for it, reporting
  // that the folder exists and what is inside. No file contents leak, so a
  // marker assertion cannot see it. This asserts the structural claim instead.
  it('does not see 20-Areas as a project, even though its name is a valid id', async () => {
    const r = await get('/vault/projects/20-Areas')
    expect(r.status).toBe(200)
    // The folder is real, one level up from the root. It must read as absent.
    expect(r.json.exists).toBe(false)
    expect(r.json.contextFile).toBe(false)
    expect(r.json.meetings).toEqual([])
  })

  it('does not see any sibling of 10-Projects as a project', async () => {
    for (const sibling of ['20-Areas', '30-Knowledge']) {
      expect((await get(`/vault/projects/${sibling}`)).json.exists).toBe(false)
    }
  })

  it('treats a nonexistent project as "no folder", not as an error to probe with', async () => {
    // A 404 here would let an attacker enumerate which project ids exist.
    // Both a real and a fabricated id answer 200; only `exists` differs.
    const real = await get('/vault/projects/juvenis-maxime')
    const fake = await get('/vault/projects/definitely-not-a-project')
    expect(real.status).toBe(fake.status)
    expect(fake.json.exists).toBe(false)
  })

  // AC-4 — the root this must not have widened
  it('leaves GET /vault/notes reachable and still scoped to 30-Knowledge', async () => {
    const notes = await fetch(`${base}/vault/notes`, {
      headers: { 'x-choda-bridge-token': TOKEN }
    })
    expect(notes.status).toBe(200)
    const body = await notes.text()
    // It still serves its own root...
    expect(body).toContain('a-note')
    // ...and still not the one next door.
    expect(body).not.toContain(PRIVATE_MARKER)
    expect(body).not.toContain('juvenis-maxime')
  })

  // AC-6
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('refuses %s — the route is read-only', async (m) => {
    const r = await send(m, '/vault/projects/juvenis-maxime')
    expect(r.status).toBeGreaterThanOrEqual(400)
    expect(r.status).toBeLessThan(500)
  })

  // AC-7
  it('requires the bridge token', async () => {
    const none = await get('/vault/projects/juvenis-maxime', {})
    expect(none.status).toBe(401)
    expect(none.text).not.toContain('juvenis-maxime')

    const wrong = await get('/vault/projects/juvenis-maxime', { 'x-choda-bridge-token': 'nope' })
    expect(wrong.status).toBe(401)
  })
})

describe('readProjectVault', () => {
  it('is pure about a missing root: no folder, no throw', () => {
    const out = readProjectVault(path.join(vaultDir, 'nope'), 'whatever')
    expect(out.exists).toBe(false)
    expect(out.meetings).toEqual([])
  })

  it('reports a real zero-byte file as present with bytes 0, not as absent', () => {
    const dir = path.join(projectsRoot(), 'zero-byte', 'meetings', '2026-01-01-x')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'note.md'), '', 'utf8')

    const m = readProjectVault(projectsRoot(), 'zero-byte').meetings[0]
    expect(m.files[0]).toEqual({ name: 'note.md', present: true, bytes: 0 })
    expect(m.files[1]).toEqual({ name: 'transcript.md', present: false, bytes: null })
  })
})
