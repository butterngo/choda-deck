// TASK-1965 — meeting audio upload/finalize/list. One test per acceptance
// criterion, driven over a real HTTP server rather than by calling the handler,
// because half the contract lives in status codes and headers.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { startCompanionServer, COMPANION_BIND, type CompanionServerHandle } from './http-server'
import type { CompanionServices } from './service-factory'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'
import { dropAudioPastCap, listMeetings, MEETINGS_DIR } from './meetings'

const TOKEN = 'meetings-test-token'

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

function chunk(
  urlPath: string,
  body: Buffer,
  headers: Record<string, string> = auth()
): Promise<{ status: number; json: Record<string, unknown> }> {
  return fetch(`${base}${urlPath}`, {
    method: 'POST',
    headers: { 'content-type': 'audio/webm', ...headers },
    body: new Uint8Array(body)
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }))
}

/** The fields these tests actually read off a meeting response. */
type MeetingBody = Record<string, unknown> & {
  id?: string
  tracks?: string[]
  bytes?: number
  audioDropped?: string[]
}

function post(urlPath: string, body?: unknown): Promise<{ status: number; json: MeetingBody }> {
  return fetch(`${base}${urlPath}`, {
    method: 'POST',
    headers: auth(body === undefined ? {} : { 'content-type': 'application/json' }),
    body: body === undefined ? undefined : JSON.stringify(body)
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }))
}

function meetingsRoot(): string {
  return path.join(artifactsDir, MEETINGS_DIR)
}

function sizeOf(id: string, track: string): number {
  return fs.statSync(path.join(meetingsRoot(), id, `${track}.webm`)).size
}

/** Fabricate a finalized meeting without going through the routes. */
function seedFinalized(id: string, startedAt: string): void {
  const dir = path.join(meetingsRoot(), id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'loopback.webm'), Buffer.alloc(16))
  fs.writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({ id, startedAt, endedAt: startedAt, tracks: ['loopback'], bytes: 16 }),
    'utf8'
  )
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choda-meetings-'))
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

describe('POST /meetings/:id/chunk', () => {
  // AC-1
  it('accepts a 4 MB chunk and writes exactly those bytes', async () => {
    const body = Buffer.alloc(4 * 1024 * 1024, 7)
    const res = await chunk('/meetings/m1/chunk?track=loopback&seq=0', body)
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ bytes: 4194304, seq: 0 })
    expect(sizeOf('m1', 'loopback')).toBe(4194304)
  })

  // AC-2 — and the tell of a broken gate is not the status but the file: a
  // handler that rejects after writing would still answer 401.
  it('rejects an untokened chunk with 401 and writes nothing at all', async () => {
    const res = await chunk('/meetings/m1/chunk?track=loopback&seq=0', Buffer.alloc(32), {})
    expect(res.status).toBe(401)
    expect(fs.existsSync(path.join(meetingsRoot(), 'm1'))).toBe(false)
  })

  // AC-3 — the whole reason this route exists instead of /capture.
  it('takes 60 MB across 15 chunks without ever answering 413', async () => {
    const body = Buffer.alloc(4 * 1024 * 1024, 3)
    const statuses: number[] = []
    for (let seq = 0; seq < 15; seq++) {
      const res = await chunk(`/meetings/big/chunk?track=loopback&seq=${seq}`, body)
      statuses.push(res.status)
    }
    expect(statuses).toEqual(Array(15).fill(200))
    expect(statuses).not.toContain(413)
    expect(sizeOf('big', 'loopback')).toBe(62914560)
  })

  // AC-4
  it('refuses a repeated seq with 409 and leaves the file byte-identical', async () => {
    await chunk('/meetings/m2/chunk?track=mic&seq=0', Buffer.alloc(10))
    await chunk('/meetings/m2/chunk?track=mic&seq=1', Buffer.alloc(10))
    const before = sizeOf('m2', 'mic')

    const repeat = await chunk('/meetings/m2/chunk?track=mic&seq=1', Buffer.alloc(10))
    expect(repeat.status).toBe(409)
    expect(sizeOf('m2', 'mic')).toBe(before)
  })

  it('refuses a GAP with 409 — a hole mid-file would still decode, which is worse', async () => {
    await chunk('/meetings/m3/chunk?track=mic&seq=0', Buffer.alloc(10))
    const gap = await chunk('/meetings/m3/chunk?track=mic&seq=2', Buffer.alloc(10))
    expect(gap.status).toBe(409)
    expect(gap.json).toMatchObject({ expected: 1 })
    expect(sizeOf('m3', 'mic')).toBe(10)
  })

  it('keeps the two tracks on independent sequences', async () => {
    await chunk('/meetings/m4/chunk?track=mic&seq=0', Buffer.alloc(5))
    const loop = await chunk('/meetings/m4/chunk?track=loopback&seq=0', Buffer.alloc(9))
    expect(loop.status).toBe(200)
    expect(sizeOf('m4', 'mic')).toBe(5)
    expect(sizeOf('m4', 'loopback')).toBe(9)
  })

  it('rejects an unknown track and a non-numeric seq with 400', async () => {
    expect((await chunk('/meetings/m5/chunk?track=speaker&seq=0', Buffer.alloc(4))).status).toBe(400)
    expect((await chunk('/meetings/m5/chunk?track=mic&seq=abc', Buffer.alloc(4))).status).toBe(400)
  })

  it('refuses a meeting id that would escape the meetings directory', async () => {
    const res = await chunk('/meetings/..%2F..%2Fdatabase/chunk?track=mic&seq=0', Buffer.alloc(4))
    expect(res.status).toBe(400)
  })
})

describe('POST /meetings/:id/finalize', () => {
  it('writes meta.json naming both tracks and the total bytes', async () => {
    await chunk('/meetings/f1/chunk?track=mic&seq=0', Buffer.alloc(100))
    await chunk('/meetings/f1/chunk?track=loopback&seq=0', Buffer.alloc(200))

    const res = await post('/meetings/f1/finalize', {
      startedAt: '2026-09-16T01:00:00.000Z',
      endedAt: '2026-09-16T01:30:00.000Z'
    })
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ id: 'f1', tracks: ['mic', 'loopback'], bytes: 300 })
    expect(JSON.parse(fs.readFileSync(path.join(meetingsRoot(), 'f1', 'meta.json'), 'utf8')).bytes).toBe(300)
  })

  it('finalizes cleanly when only one track was ever recorded (no microphone)', async () => {
    await chunk('/meetings/f2/chunk?track=loopback&seq=0', Buffer.alloc(50))
    const res = await post('/meetings/f2/finalize')
    expect(res.status).toBe(200)
    expect(res.json.tracks).toEqual(['loopback'])
  })

  it('404s a meeting that never received a chunk', async () => {
    expect((await post('/meetings/nope/finalize')).status).toBe(404)
  })
})

describe('retention', () => {
  // TASK-1965 AC-5 as rewritten by TASK-2009's option A. The cap now bounds
  // AUDIO, not meetings: the 21st recording costs the oldest meeting its .webm
  // files and nothing else. The old version of this test asserted the directory
  // was gone and that exactly 20 remained — both are now the wrong behaviour.
  it('drops audio from the oldest recording when a 21st is finalized, and keeps the meeting', async () => {
    for (let i = 0; i < 20; i++) {
      seedFinalized(`old-${String(i).padStart(2, '0')}`, `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`)
    }
    await chunk('/meetings/newest/chunk?track=loopback&seq=0', Buffer.alloc(8))
    const res = await post('/meetings/newest/finalize', { startedAt: '2026-10-01T00:00:00.000Z' })

    expect(res.status).toBe(200)
    expect(res.json.audioDropped).toEqual(['old-00'])
    // The meeting survives; only its audio is gone.
    expect(fs.existsSync(path.join(meetingsRoot(), 'old-00'))).toBe(true)
    expect(fs.existsSync(path.join(meetingsRoot(), 'old-00', 'loopback.webm'))).toBe(false)
    expect(fs.readdirSync(meetingsRoot()).length).toBe(21)
    // And it is still listed, flagged, and weighs nothing.
    const row = listMeetings(artifactsDir).find((m) => m.id === 'old-00')
    expect(row?.bytes).toBe(0)
    expect(typeof row?.audioDeletedAt).toBe('string')
    // The control: the 20 kept meetings still have their audio.
    expect(fs.existsSync(path.join(meetingsRoot(), 'old-01', 'loopback.webm'))).toBe(true)
  })

  it('never evicts an in-progress recording — it has no meta.json and is invisible', async () => {
    for (let i = 0; i < 25; i++) {
      seedFinalized(`f-${String(i).padStart(2, '0')}`, `2026-08-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`)
    }
    await chunk('/meetings/live/chunk?track=mic&seq=0', Buffer.alloc(4))

    dropAudioPastCap(artifactsDir)
    expect(fs.existsSync(path.join(meetingsRoot(), 'live'))).toBe(true)
    expect(fs.existsSync(path.join(meetingsRoot(), 'live', 'mic.webm'))).toBe(true)
    // Every finalized meeting is still listed — the cap bounds audio, not rows.
    expect(listMeetings(artifactsDir).length).toBe(25)
  })
})

describe('GET /meetings', () => {
  it('lists finalized meetings newest first and omits in-progress ones', async () => {
    seedFinalized('older', '2026-01-01T00:00:00.000Z')
    seedFinalized('newer', '2026-06-01T00:00:00.000Z')
    await chunk('/meetings/inflight/chunk?track=mic&seq=0', Buffer.alloc(4))

    const res = await fetch(`${base}/meetings`, { headers: auth() })
    const list = (await res.json()) as Array<{ id: string }>
    expect(res.status).toBe(200)
    expect(list.map((m) => m.id)).toEqual(['newer', 'older'])
  })

  it('401s without the token', async () => {
    expect((await fetch(`${base}/meetings`)).status).toBe(401)
  })
})

describe('GET /artifacts/meetings/... (playback)', () => {
  // AC-6 — before the MIME entry existed this served application/octet-stream
  // and an <audio> element refused it.
  it('serves a recorded track as audio/webm', async () => {
    const body = Buffer.from('fake-opus-bytes')
    await chunk('/meetings/play/chunk?track=loopback&seq=0', body)
    await post('/meetings/play/finalize')

    const res = await fetch(`${base}/artifacts/meetings/play/loopback.webm`, { headers: auth() })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/webm')
    expect(Buffer.from(await res.arrayBuffer()).equals(body)).toBe(true)
  })
})
