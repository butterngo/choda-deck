// TASK-2043 — a meeting's title: generated from the transcript, editable by hand.
//
// The rename half is driven over a real HTTP server, like meetings.test.ts, because
// the contract lives in status codes as much as in the file it writes. The
// generation half is unit-tested against an injected fetch — the point of those
// tests is what happens when the model DOESN'T answer, which a live call cannot
// stage on demand.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { startCompanionServer, COMPANION_BIND, type CompanionServerHandle } from './http-server'
import type { CompanionServices } from './service-factory'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'
import { listMeetings, readMeta, MEETINGS_DIR } from './meetings'
import {
  TITLE_MAX_CHARS,
  buildTitleInput,
  generateTitle,
  normalizeTitle,
  writeTitle
} from './meeting-title'
import type { TranscriptSegment } from './meeting-transcribe'

const TOKEN = 'meeting-title-test-token'

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

function auth(extra: Record<string, string> = {}): Record<string, string> {
  return { 'x-choda-bridge-token': TOKEN, ...extra }
}

function meetingsRoot(): string {
  return path.join(artifactsDir, MEETINGS_DIR)
}

function metaFile(id: string): string {
  return path.join(meetingsRoot(), id, 'meta.json')
}

function patch(
  id: string,
  body?: unknown,
  method = 'PATCH'
): Promise<{ status: number; json: Record<string, unknown> }> {
  return fetch(`${base}/meetings/${id}`, {
    method,
    headers: auth(body === undefined ? {} : { 'content-type': 'application/json' }),
    body: body === undefined ? undefined : JSON.stringify(body)
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }))
}

/**
 * A finalized meeting with NO title key at all — the shape every meeting
 * recorded before TASK-2043 has on disk.
 */
function seedLegacy(id: string, startedAt = '2026-09-10T08:00:00.000Z'): void {
  const dir = path.join(meetingsRoot(), id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'loopback.webm'), Buffer.alloc(16))
  fs.writeFileSync(
    metaFile(id),
    JSON.stringify({
      id,
      startedAt,
      endedAt: startedAt,
      tracks: ['loopback'],
      bytes: 16,
      transcribedAt: '2026-09-10T08:30:00.000Z',
      audioDeletedAt: null
    }),
    'utf8'
  )
}

function seg(text: string, startMs = 0): TranscriptSegment {
  return {
    track: 'loopback',
    speaker: 'Them',
    startMs,
    endMs: startMs + 2000,
    text,
    locale: 'vi-VN'
  }
}

/** An injected fetch that answers the chat-completions call with `content`. */
function fetchAnswering(content: string): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })) as unknown as typeof fetch
}

function writeAzureConfig(): void {
  fs.writeFileSync(
    path.join(dataDir, 'ai-provider.json'),
    JSON.stringify({
      provider: 'azure',
      endpoint: 'https://example.invalid',
      deployment: 'gpt-test',
      apiVersion: '2024-10-21'
    }),
    'utf8'
  )
  fs.writeFileSync(path.join(dataDir, 'ai-key.txt'), 'test-key', 'utf8')
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choda-meeting-title-'))
  artifactsDir = path.join(dataDir, 'artifacts')
  fs.mkdirSync(artifactsDir, { recursive: true })

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
  try {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    /* temp dir; the OS reclaims it */
  }
})

beforeEach(() => {
  fs.rmSync(meetingsRoot(), { recursive: true, force: true })
})

describe('a meeting recorded before titles existed', () => {
  // AC-1
  it('still lists, and reads back with no title rather than throwing', () => {
    seedLegacy('m-legacy')
    const listed = listMeetings(artifactsDir)
    expect(listed).toHaveLength(1)
    expect(listed[0].id).toBe('m-legacy')
    expect(listed[0].title ?? null).toBeNull()
    // The absence is real, not a null someone wrote: the key is not on disk.
    const onDisk = JSON.parse(fs.readFileSync(metaFile('m-legacy'), 'utf8')) as Record<string, unknown>
    expect('title' in onDisk).toBe(false)
  })
})

describe('PATCH /meetings/:id', () => {
  // AC-4
  it('writes the title and leaves every other field byte-identical', async () => {
    seedLegacy('m-rename')
    const before = JSON.parse(fs.readFileSync(metaFile('m-rename'), 'utf8')) as Record<string, unknown>

    const res = await patch('m-rename', { title: 'Kate — assessment scope' })
    expect(res.status).toBe(200)
    expect(res.json.title).toBe('Kate — assessment scope')

    const after = JSON.parse(fs.readFileSync(metaFile('m-rename'), 'utf8')) as Record<string, unknown>
    expect(after.title).toBe('Kate — assessment scope')
    // Every key that existed before, unchanged. Compared field by field so a
    // failure names the field that moved.
    for (const key of Object.keys(before)) {
      expect({ key, value: after[key] }).toEqual({ key, value: before[key] })
    }
    // ...and nothing was invented beyond the one new key.
    expect(new Set(Object.keys(after))).toEqual(new Set([...Object.keys(before), 'title']))
  })

  // AC-4 — the field this is most likely to trample
  it('does not disturb a later transcribedAt or audioDeletedAt', async () => {
    seedLegacy('m-stamps')
    const raw = JSON.parse(fs.readFileSync(metaFile('m-stamps'), 'utf8')) as Record<string, unknown>
    raw.audioDeletedAt = '2026-09-11T00:00:00.000Z'
    raw.bytes = 0
    fs.writeFileSync(metaFile('m-stamps'), JSON.stringify(raw), 'utf8')

    await patch('m-stamps', { title: 'renamed after the audio went' })

    const after = readMeta(artifactsDir, 'm-stamps')
    expect(after?.audioDeletedAt).toBe('2026-09-11T00:00:00.000Z')
    expect(after?.transcribedAt).toBe('2026-09-10T08:30:00.000Z')
    expect(after?.bytes).toBe(0)
    expect(after?.title).toBe('renamed after the audio went')
  })

  it('trims and collapses whitespace rather than storing it', async () => {
    seedLegacy('m-ws')
    const res = await patch('m-ws', { title: '  Kate   —\n  scope  ' })
    expect(res.status).toBe(200)
    expect(res.json.title).toBe('Kate — scope')
  })

  it('accepts an explicit null and clears the title', async () => {
    seedLegacy('m-clear')
    await patch('m-clear', { title: 'something' })
    const res = await patch('m-clear', { title: null })
    expect(res.status).toBe(200)
    expect(res.json.title).toBeNull()
    expect(readMeta(artifactsDir, 'm-clear')?.title).toBeNull()
  })

  // AC-5 — one case per rejected input, each asserting nothing was written
  it.each([
    ['empty string', { title: '' }],
    ['whitespace only', { title: '   \n\t ' }],
    ['over the length cap', { title: 'x'.repeat(TITLE_MAX_CHARS + 1) }],
    ['a number', { title: 42 }],
    ['an object', { title: { text: 'no' } }],
    ['title absent', {}]
  ])('rejects %s with a 4xx and writes nothing', async (_label, body) => {
    seedLegacy('m-bad')
    const before = fs.readFileSync(metaFile('m-bad'), 'utf8')

    const res = await patch('m-bad', body)
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    expect(fs.readFileSync(metaFile('m-bad'), 'utf8')).toBe(before)
  })

  it('answers 404 for an id that does not exist, and writes nothing', async () => {
    const res = await patch('m-nope', { title: 'ghost' })
    expect(res.status).toBe(404)
    expect(fs.existsSync(path.join(meetingsRoot(), 'm-nope'))).toBe(false)
  })

  it('answers 409 for a meeting still being recorded', async () => {
    fs.mkdirSync(path.join(meetingsRoot(), 'm-live'), { recursive: true })
    const res = await patch('m-live', { title: 'too early' })
    expect(res.status).toBe(409)
  })

  it('refuses a body that is not JSON', async () => {
    seedLegacy('m-notjson')
    const res = await fetch(`${base}/meetings/m-notjson`, {
      method: 'PATCH',
      headers: auth({ 'content-type': 'application/json' }),
      body: 'not json'
    })
    expect(res.status).toBe(400)
  })

  it('answers 405 to a non-PATCH on the same path', async () => {
    seedLegacy('m-method')
    const res = await patch('m-method', { title: 'x' }, 'PUT')
    expect(res.status).toBe(405)
  })

  it('refuses an id outside the allowed alphabet without reaching the filesystem', async () => {
    const res = await fetch(`${base}/meetings/..`, {
      method: 'PATCH',
      headers: auth({ 'content-type': 'application/json' }),
      body: JSON.stringify({ title: 'traversal' })
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })

  it('requires the bridge token', async () => {
    seedLegacy('m-auth')
    const res = await fetch(`${base}/meetings/m-auth`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'unauthenticated' })
    })
    expect(res.status).toBe(401)
  })

  // The route this one must not have broken.
  it('leaves DELETE /meetings/:id/audio reachable', async () => {
    seedLegacy('m-coexist')
    const res = await fetch(`${base}/meetings/m-coexist/audio`, {
      method: 'DELETE',
      headers: auth()
    })
    expect(res.status).toBe(200)
  })
})

describe('normalizeTitle', () => {
  it('collapses control characters instead of rejecting the title', () => {
    expect(normalizeTitle('Kate\nscope\tand date')).toBe('Kate scope and date')
  })

  it('truncates at the cap rather than refusing', () => {
    const long = 'w'.repeat(TITLE_MAX_CHARS + 50)
    expect(normalizeTitle(long)).toHaveLength(TITLE_MAX_CHARS)
  })

  it.each([['', 'empty'], ['   ', 'blank'], [null, 'null'], [7, 'a number']])(
    'returns null for %s (%s)',
    (input) => {
      expect(normalizeTitle(input)).toBeNull()
    }
  )
})

describe('buildTitleInput', () => {
  it('tags each line with its speaker', () => {
    expect(buildTitleInput([seg('xin chào'), seg('hello', 3000)])).toBe('Them: xin chào\nThem: hello')
  })

  it('stops at the prompt budget instead of sending the whole meeting', () => {
    const many = Array.from({ length: 5000 }, (_, i) => seg('a fairly long sentence here', i * 1000))
    expect(buildTitleInput(many).length).toBeLessThanOrEqual(6000)
  })
})

describe('generateTitle', () => {
  // AC-2 — the happy path
  it('returns the model’s title', async () => {
    writeAzureConfig()
    const title = await generateTitle([seg('chúng ta bàn về phạm vi assessment')], {
      dataDir,
      fetchImpl: fetchAnswering(JSON.stringify({ title: 'Phạm vi assessment' }))
    })
    expect(title).toBe('Phạm vi assessment')
  })

  // AC-2 — the failure paths, which are the reason this function exists
  it('returns null for an empty transcript without calling the model', async () => {
    writeAzureConfig()
    let called = false
    const spy = (async () => {
      called = true
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    expect(await generateTitle([], { dataDir, fetchImpl: spy })).toBeNull()
    expect(called).toBe(false)
  })

  it('returns null when no model is configured', async () => {
    expect(await generateTitle([seg('hello')], { dataDir: undefined })).toBeNull()
  })

  it('returns null when the provider refuses', async () => {
    writeAzureConfig()
    const failing = (async () =>
      new Response(JSON.stringify({ error: 'nope' }), { status: 401 })) as unknown as typeof fetch
    expect(await generateTitle([seg('hello')], { dataDir, fetchImpl: failing })).toBeNull()
  })

  it('returns null when the model answers with something that is not a title', async () => {
    writeAzureConfig()
    expect(
      await generateTitle([seg('hello')], {
        dataDir,
        fetchImpl: fetchAnswering(JSON.stringify({ title: '   ' }))
      })
    ).toBeNull()
  })
})

describe('writeTitle', () => {
  it('re-reads meta from disk so a concurrent stamp is not reverted', () => {
    seedLegacy('m-concurrent')
    // Something else writes a stamp between the caller's read and this write.
    const raw = JSON.parse(fs.readFileSync(metaFile('m-concurrent'), 'utf8')) as Record<string, unknown>
    raw.audioDeletedAt = '2026-09-12T00:00:00.000Z'
    fs.writeFileSync(metaFile('m-concurrent'), JSON.stringify(raw), 'utf8')

    writeTitle(artifactsDir, 'm-concurrent', 'named later')

    const after = readMeta(artifactsDir, 'm-concurrent')
    expect(after?.audioDeletedAt).toBe('2026-09-12T00:00:00.000Z')
    expect(after?.title).toBe('named later')
  })

  it('returns null for a meeting with no readable meta', () => {
    fs.mkdirSync(path.join(meetingsRoot(), 'm-nometa'), { recursive: true })
    expect(writeTitle(artifactsDir, 'm-nometa', 'x')).toBeNull()
  })
})
