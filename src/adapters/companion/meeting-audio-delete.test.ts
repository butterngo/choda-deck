// TASK-2003 — DELETE /meetings/:id/audio: reclaim the expensive half of a
// meeting and keep the durable half.
//
// The criterion that carries this feature is AC-1's second clause: the
// transcript must be BYTE-identical afterwards. `evictOldest` already removes a
// meeting directory wholesale, and the cheap way to implement this route is to
// call it — which passes "the .webm files are gone" while destroying the thing
// the user was trying to keep. So the transcript is hashed before and after,
// not merely checked for existence.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createHash } from 'crypto'
import { startCompanionServer, COMPANION_BIND, type CompanionServerHandle } from './http-server'
import type { CompanionServices } from './service-factory'
import { MEETINGS_DIR } from './meetings'

const TOKEN = 'audio-delete-token'

let dataDir: string
let artifactsDir: string
let handle: CompanionServerHandle
let base: string

const auth = (extra: Record<string, string> = {}): Record<string, string> => ({
  'x-choda-bridge-token': TOKEN,
  ...extra
})

const root = (): string => path.join(artifactsDir, MEETINGS_DIR)
const dirOf = (id: string): string => path.join(root(), id)

function del(id: string): Promise<{ status: number; json: Record<string, unknown> }> {
  return fetch(`${base}/meetings/${id}/audio`, { method: 'DELETE', headers: auth() }).then(async (r) => ({
    status: r.status,
    json: (await r.json().catch(() => ({}))) as Record<string, unknown>
  }))
}

function list(): Promise<Array<Record<string, unknown>>> {
  return fetch(`${base}/meetings`, { headers: auth() }).then(
    (r) => r.json() as Promise<Array<Record<string, unknown>>>
  )
}

const sha = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

/** A directory listing hash — proves "nothing on disk changed", names included. */
function treeSha(dir: string): string {
  const h = createHash('sha256')
  for (const name of fs.readdirSync(dir).sort()) {
    h.update(name).update(String(fs.statSync(path.join(dir, name)).size))
  }
  return h.digest('hex')
}

/** A finalized, transcribed meeting with two tracks. */
function seed(id: string, opts: { finalized?: boolean } = {}): void {
  const dir = dirOf(id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'mic.webm'), Buffer.alloc(1024, 7))
  fs.writeFileSync(path.join(dir, 'loopback.webm'), Buffer.alloc(2048, 9))
  fs.writeFileSync(
    path.join(dir, 'transcript.json'),
    JSON.stringify({ segments: [{ track: 'mic', speaker: 'Me', startMs: 0, endMs: 1000, text: 'đoạn một' }] })
  )
  if (opts.finalized !== false) {
    fs.writeFileSync(
      path.join(dir, 'meta.json'),
      JSON.stringify({
        id,
        startedAt: '2026-09-17T07:00:00.000Z',
        endedAt: '2026-09-17T07:30:00.000Z',
        tracks: ['mic', 'loopback'],
        bytes: 3072
      })
    )
  }
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choda-audio-del-'))
  artifactsDir = path.join(dataDir, 'artifacts')
  fs.mkdirSync(artifactsDir, { recursive: true })
  const services = {
    svc: {
      listProjects: async () => [],
      findTasks: async () => [],
      findInbox: async () => [],
      findConversations: async () => [],
      findWorkspaces: async () => []
    },
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
  await handle?.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

beforeEach(() => {
  fs.rmSync(root(), { recursive: true, force: true })
  fs.mkdirSync(root(), { recursive: true })
})

describe('AC-1 — the audio goes, the transcript survives byte for byte', () => {
  it('removes both .webm files and leaves transcript.json unchanged', async () => {
    seed('m1')
    const before = sha(path.join(dirOf('m1'), 'transcript.json'))

    const r = await del('m1')
    expect(r.status).toBe(200)
    expect(r.json.freedBytes).toBe(3072)

    expect(fs.existsSync(path.join(dirOf('m1'), 'mic.webm'))).toBe(false)
    expect(fs.existsSync(path.join(dirOf('m1'), 'loopback.webm'))).toBe(false)
    // A route that removed the directory passes the two lines above and fails here.
    expect(fs.existsSync(path.join(dirOf('m1'), 'transcript.json'))).toBe(true)
    expect(sha(path.join(dirOf('m1'), 'transcript.json'))).toBe(before)
  })
})

describe('AC-2 — the meeting is still listed, and says its audio is gone', () => {
  it('keeps the row with bytes 0, an ISO audioDeletedAt and its tracks', async () => {
    seed('m2')
    await del('m2')

    const rows = await list()
    const row = rows.find((m) => m.id === 'm2')
    expect(row).toBeDefined()
    expect(row?.bytes).toBe(0)
    expect(typeof row?.audioDeletedAt).toBe('string')
    expect(Number.isNaN(Date.parse(String(row?.audioDeletedAt)))).toBe(false)
    expect(row?.tracks).toEqual(['mic', 'loopback'])
  })
})

describe('AC-3 — deleting twice is not an error and is not a second deletion', () => {
  it('answers 200 freedBytes 0 and changes nothing on disk', async () => {
    seed('m3')
    await del('m3')
    const after1 = treeSha(dirOf('m3'))

    const r = await del('m3')
    expect(r.status).toBe(200)
    expect(r.json.freedBytes).toBe(0)
    expect(treeSha(dirOf('m3'))).toBe(after1)
  })
})

describe('AC-4 — a recording still in progress is refused', () => {
  it('answers 409 and both tracks are still on disk', async () => {
    seed('m4', { finalized: false })
    const r = await del('m4')
    expect(r.status).toBe(409)
    expect(r.json.error).toBe('not finalized')
    expect(fs.existsSync(path.join(dirOf('m4'), 'mic.webm'))).toBe(true)
    expect(fs.existsSync(path.join(dirOf('m4'), 'loopback.webm'))).toBe(true)
  })
})

describe('AC-5 — an unknown id touches nothing', () => {
  it('answers 404 and the meetings root is unchanged', async () => {
    seed('m5')
    const before = treeSha(root())
    const r = await del('m-not-a-meeting')
    expect(r.status).toBe(404)
    expect(treeSha(root())).toBe(before)
    expect(fs.existsSync(path.join(dirOf('m5'), 'mic.webm'))).toBe(true)
  })
})
