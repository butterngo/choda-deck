// TASK-1576 — GET /vault/*. One test per acceptance criterion.
//
// The traversal and scoping cases assert both the status AND that the secret
// bytes never came back: a broken guard's tell is a 200 whose body contains the
// marker planted in 20-Areas. Asserting only the status would pass against a
// guard that refuses the wrong paths and serves the right ones.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as net from 'net'
import { startCompanionServer, COMPANION_BIND, type CompanionServerHandle } from './http-server'
import type { CompanionServices } from './service-factory'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'
import { parseFrontmatter } from './vault'

const TOKEN = 'vault-test-token'

// A real 1x1 JPEG-ish payload; byte-identity is part of the contract, so a
// buffer of zeros would not prove the stream is untouched.
const IMG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

// Planted in 20-Areas. If this string ever appears in a response body, the
// scoping guard has failed regardless of what status code came with it.
const PRIVATE_MARKER = 'BUTTER_PRIVATE_PREFERENCES_DO_NOT_SERVE'

const NOTE = `---
source: youtube
url: https://www.youtube.com/watch?v=abc123
title: A Test Note About Gateways
channel: TechSimplified
captured: 2026-08-05
generated_by: claude
tier: T1
tags: [video, bpmn, automation]
---

## TL;DR
Body text.

## Key points
- **[10:11]** A claim.
  ![10:11](assets/note-one/10-11.jpg)
`

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
 * `fetch` collapses `../` and `%2e%2e` before the bytes leave the client, so a
 * traversal sent through it arrives as an ordinary path and never reaches the
 * guard — the test would prove nothing. An attacker has no such courtesy.
 * (Same rationale as artifacts.test.ts.)
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
      sock.destroy()
      resolve({ status, body: raw.toString('latin1') })
    })
  })
}

beforeAll(async () => {
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choda-vault-'))

  const notes = path.join(vaultDir, '30-Knowledge')
  fs.mkdirSync(notes, { recursive: true })
  fs.writeFileSync(path.join(notes, 'note-one.md'), NOTE, 'utf8')
  fs.writeFileSync(path.join(notes, 'note-two.md'), '# no frontmatter here\n', 'utf8')
  fs.writeFileSync(path.join(notes, 'ignored.txt'), 'not a note', 'utf8')
  // TASK-1601 link fixtures: one resolvable plain link, one aliased and one
  // anchored link to the same note, and one target with no file behind it.
  fs.writeFileSync(
    path.join(notes, 'note-linker.md'),
    'Links to [[note-two]], [[note-one|An Alias]], [[note-one#a-heading]] and [[does-not-exist]].\n',
    'utf8'
  )

  const assets = path.join(notes, 'assets', 'note-one')
  fs.mkdirSync(assets, { recursive: true })
  fs.writeFileSync(path.join(assets, '10-11.jpg'), IMG_BYTES)

  // OUTSIDE the served root — the traversal / scoping target.
  const areas = path.join(vaultDir, '20-Areas')
  fs.mkdirSync(areas, { recursive: true })
  fs.writeFileSync(path.join(areas, 'preferences.md'), PRIVATE_MARKER, 'utf8')

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
  // Windows holds a lock briefly after a served file's read stream closes; a
  // bare rmSync races teardown and throws EBUSY, killing the worker fork.
  try {
    fs.rmSync(vaultDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    /* temp dir; the OS reclaims it */
  }
})

describe('GET /vault/notes', () => {
  it('AC-1: lists notes with frontmatter parsed', async () => {
    const r = await get('/vault/notes')
    expect(r.status).toBe(200)
    const notes = JSON.parse(r.body.toString('utf8')) as Array<Record<string, unknown>>

    // .txt is not a note; exactly the .md files come back. (note-linker was
    // added as a TASK-1601 link fixture — the assertion still pins the exact
    // set, so the .txt exclusion this guards is unweakened.)
    expect(notes.map((n) => n.slug).sort()).toEqual(['note-linker', 'note-one', 'note-two'])

    const one = notes.find((n) => n.slug === 'note-one')!
    expect(one.title).toBe('A Test Note About Gateways')
    expect(one.tags).toEqual(['video', 'bpmn', 'automation'])
    expect(one.captured).toBe('2026-08-05')
    expect(one.generatedBy).toBe('claude')
  })

  it('a note with no frontmatter still lists, falling back to its slug', async () => {
    const r = await get('/vault/notes')
    const two = (JSON.parse(r.body.toString('utf8')) as Array<Record<string, unknown>>).find(
      (n) => n.slug === 'note-two'
    )!
    // Malformed frontmatter must not make a note invisible — it must stay openable.
    expect(two.title).toBe('note-two')
    expect(two.tags).toEqual([])
  })
})

describe('GET /vault/notes/:slug', () => {
  it('AC-2: returns the note markdown', async () => {
    const r = await get('/vault/notes/note-one')
    expect(r.status).toBe(200)
    expect(r.type).toContain('text/markdown')
    expect(r.body.toString('utf8')).toBe(NOTE)
  })

  it('404s an unknown slug', async () => {
    expect((await get('/vault/notes/nope')).status).toBe(404)
  })
})

describe('GET /vault/assets/*', () => {
  it('AC-3: serves the image byte-identically with an image content-type', async () => {
    const r = await get('/vault/assets/note-one/10-11.jpg')
    expect(r.status).toBe(200)
    expect(r.type).toBe('image/jpeg')
    // Byte-identity, not just a 200 — a truncating stream would still be a 200.
    expect(r.body.equals(IMG_BYTES)).toBe(true)
  })
})

describe('auth', () => {
  it('AC-4: every route 401s without a token', async () => {
    for (const p of ['/vault/notes', '/vault/notes/note-one', '/vault/assets/note-one/10-11.jpg']) {
      expect((await get(p, {})).status).toBe(401)
    }
  })

  it('AC-4: every route 401s with a wrong token', async () => {
    const bad = { 'x-choda-bridge-token': 'not-the-token' }
    for (const p of ['/vault/notes', '/vault/notes/note-one', '/vault/assets/note-one/10-11.jpg']) {
      expect((await get(p, bad)).status).toBe(401)
    }
  })
})

describe('sandboxing', () => {
  it('AC-5: refuses traversal and never returns the private marker', async () => {
    const attempts = [
      '/vault/assets/../../20-Areas/preferences.md',
      '/vault/assets/%2e%2e/%2e%2e/20-Areas/preferences.md',
      '/vault/notes/../20-Areas/preferences',
      '/vault/notes/%2e%2e%2f20-Areas%2fpreferences',
      '/vault/assets/....//20-Areas/preferences.md'
    ]
    for (const a of attempts) {
      const r = await rawGet(a)
      expect(r.status).not.toBe(200)
      // The load-bearing assertion: whatever the status, the bytes never leaked.
      expect(r.body).not.toContain(PRIVATE_MARKER)
    }
  })

  it('AC-5: refuses an absolute path', async () => {
    const r = await rawGet('/vault/assets//etc/passwd')
    expect(r.status).not.toBe(200)
  })

  it('AC-6: 20-Areas is unreachable — the root is 30-Knowledge, not the vault', async () => {
    // Not a traversal: a plainly-named request for the sibling directory. It
    // fails because the sandbox root never included it, not because a filter
    // caught the string "20-Areas".
    const r = await rawGet('/vault/notes/20-Areas/preferences')
    expect(r.status).not.toBe(200)
    expect(r.body).not.toContain(PRIVATE_MARKER)
  })
})

describe('configuration', () => {
  it('AC-7: 501s when no vault dir is configured, rather than guessing one', async () => {
    const services = {
      svc: fakeSvc,
      db: null,
      dbPath: ':memory:',
      intervalMs: 30000,
      bridgeToken: TOKEN,
      // vaultDir deliberately absent
      pull: async () => ({ upserted: 0, tombstoned: 0, cursor: 0 }),
      push: async () => ({ drained: 0, conflicts: 0, remaining: 0, reachable: true }),
      close: () => {}
    } as unknown as CompanionServices

    const h = await startCompanionServer(services, 0)
    try {
      const r = await fetch(`http://${COMPANION_BIND}:${h.address.port}/vault/notes`, {
        headers: { 'x-choda-bridge-token': TOKEN }
      })
      expect(r.status).toBe(501)
    } finally {
      await h.close()
    }
  })
})

// TASK-1601 — GET /vault/links. Fixtures live in the same 30-Knowledge root as
// the rest of the suite: note-one links to note-two and to a target that does
// not exist, note-two links back to note-one.
describe('GET /vault/links', () => {
  it('maps every note slug to outgoing + incoming', async () => {
    const r = await get('/vault/links')
    expect(r.status).toBe(200)
    const links = JSON.parse(r.body.toString('utf8'))
    for (const slug of ['note-one', 'note-two', 'note-linker']) {
      expect(links[slug]).toBeDefined()
      expect(Array.isArray(links[slug].outgoing)).toBe(true)
      expect(Array.isArray(links[slug].incoming)).toBe(true)
    }
  })

  it('is symmetric across every resolvable link', async () => {
    const links = JSON.parse((await get('/vault/links')).body.toString('utf8'))
    // Asserting the whole payload, not one pair: an implementation that filled
    // `outgoing` and left `incoming` empty would pass a single-pair check.
    for (const [slug, entry] of Object.entries<{ outgoing: string[]; incoming: string[] }>(links)) {
      for (const target of entry.outgoing) {
        if (links[target]) expect(links[target].incoming).toContain(slug)
      }
    }
    expect(links['note-two'].incoming).toContain('note-linker')
    expect(links['note-linker'].outgoing).toContain('note-two')
  })

  it('reports a dangling link without inventing a note for it', async () => {
    const links = JSON.parse((await get('/vault/links')).body.toString('utf8'))
    expect(links['note-linker'].outgoing).toContain('does-not-exist')
    // The whole point: a target with no file must not become a top-level key.
    expect(Object.keys(links)).not.toContain('does-not-exist')
  })

  it('resolves aliased and anchored links to the same note', async () => {
    const links = JSON.parse((await get('/vault/links')).body.toString('utf8'))
    // note-linker carries [[note-one|An Alias]] and [[note-one#a-heading]];
    // both must collapse to `note-one`, not two dangling slugs.
    expect(links['note-linker'].outgoing).toContain('note-one')
    expect(links['note-linker'].outgoing.filter((t: string) => t.includes('|'))).toEqual([])
    expect(links['note-linker'].outgoing.filter((t: string) => t.includes('#'))).toEqual([])
  })

  it('requires the bridge token', async () => {
    const r = await get('/vault/links', {})
    expect(r.status).toBe(401)
    const wrong = await get('/vault/links', { 'x-choda-bridge-token': 'nope' })
    expect(wrong.status).toBe(401)
  })
})

describe('parseFrontmatter', () => {
  it('returns empty for a note with no frontmatter', () => {
    expect(parseFrontmatter('# just a heading\n')).toEqual({})
  })

  it('does not treat a mid-document --- as frontmatter', () => {
    expect(parseFrontmatter('text\n---\ntitle: nope\n---\n')).toEqual({})
  })

  it('keeps colons in values intact', () => {
    const fm = parseFrontmatter('---\nurl: https://x.test/a?b=c\n---\n')
    expect(fm.url).toBe('https://x.test/a?b=c')
  })
})
