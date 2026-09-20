// TASK-2044 — DELETE /meetings/:id removes the whole meeting.
//
// The load-bearing test is the CONTROL: "the directory is gone" passes just as
// well for a handler that wiped every meeting on disk. Every deletion test here
// seeds a sibling and asserts the sibling survived intact.
//
// The second thing under test is that this route did not shadow
// DELETE /meetings/:id/audio, which differs from it by one path segment and by
// its entire meaning.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createHash } from 'crypto'
import { startCompanionServer, COMPANION_BIND, type CompanionServerHandle } from './http-server'
import type { CompanionServices } from './service-factory'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'
import { listMeetings, MEETINGS_DIR } from './meetings'

const TOKEN = 'meeting-delete-test-token'

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

function meetingPath(id: string): string {
  return path.join(meetingsRoot(), id)
}

function del(urlPath: string): Promise<{ status: number; json: Record<string, unknown> }> {
  return fetch(`${base}${urlPath}`, { method: 'DELETE', headers: auth() }).then(async (r) => ({
    status: r.status,
    json: (await r.json().catch(() => ({}))) as Record<string, unknown>
  }))
}

/** A finalized meeting with audio, a transcript and a saved note. */
function seed(id: string, opts: { finalized?: boolean } = {}): void {
  const finalized = opts.finalized ?? true
  const dir = meetingPath(id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'mic.webm'), Buffer.alloc(32, 1))
  fs.writeFileSync(path.join(dir, 'loopback.webm'), Buffer.alloc(64, 2))
  fs.writeFileSync(
    path.join(dir, 'transcript.json'),
    JSON.stringify({ meetingId: id, createdAt: '2026-09-18T00:00:00.000Z', segments: [] }),
    'utf8'
  )
  fs.writeFileSync(path.join(dir, 'note.md'), `# ${id}\n`, 'utf8')
  if (finalized) {
    fs.writeFileSync(
      path.join(dir, 'meta.json'),
      JSON.stringify({
        id,
        startedAt: '2026-09-18T08:00:00.000Z',
        endedAt: '2026-09-18T08:25:00.000Z',
        tracks: ['mic', 'loopback'],
        bytes: 96
      }),
      'utf8'
    )
  }
}

/** A fingerprint of everything in a meeting directory, for the survival control. */
function fingerprint(id: string): string {
  const dir = meetingPath(id)
  const names = fs.readdirSync(dir).sort()
  const h = createHash('sha256')
  for (const name of names) {
    h.update(name)
    h.update(fs.readFileSync(path.join(dir, name)))
  }
  return h.digest('hex')
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choda-meeting-delete-'))
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

describe('DELETE /meetings/:id', () => {
  // AC-1 — with the control that makes it mean anything
  it('removes the directory and everything in it, and leaves siblings untouched', async () => {
    seed('m-doomed')
    seed('m-keeper')
    const keeperBefore = fingerprint('m-keeper')

    const res = await del('/meetings/m-doomed')
    expect(res.status).toBe(200)
    expect(res.json.deleted).toBe(true)

    expect(fs.existsSync(meetingPath('m-doomed'))).toBe(false)
    expect(listMeetings(artifactsDir).map((m) => m.id)).toEqual(['m-keeper'])
    // The control: the other meeting is byte-for-byte what it was.
    expect(fingerprint('m-keeper')).toBe(keeperBefore)
  })

  it('removes the transcript and the note, not only the audio', async () => {
    seed('m-all')
    await del('/meetings/m-all')
    expect(fs.existsSync(path.join(meetingPath('m-all'), 'transcript.json'))).toBe(false)
    expect(fs.existsSync(path.join(meetingPath('m-all'), 'note.md'))).toBe(false)
  })

  // AC-4
  it('answers 404 for an id that does not exist, and deletes nothing', async () => {
    seed('m-bystander')
    const before = fingerprint('m-bystander')
    const res = await del('/meetings/m-ghost')
    expect(res.status).toBe(404)
    expect(fingerprint('m-bystander')).toBe(before)
  })

  it('refuses a meeting still being recorded', async () => {
    seed('m-live', { finalized: false })
    const res = await del('/meetings/m-live')
    expect(res.status).toBe(409)
    // Still there — a recorder is appending to it.
    expect(fs.existsSync(meetingPath('m-live'))).toBe(true)
  })

  // AC-3
  it.each(['..', '%2e%2e', 'a/../..', '.', 'has space', 'a%2Fb'])(
    'refuses the id %s without deleting anything',
    async (bad) => {
      seed('m-safe')
      const before = fingerprint('m-safe')

      const res = await fetch(`${base}/meetings/${bad}`, { method: 'DELETE', headers: auth() })
      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(res.status).toBeLessThan(500)

      // Nothing under the meetings root moved, and the root itself survives.
      expect(fs.existsSync(meetingPath('m-safe'))).toBe(true)
      expect(fingerprint('m-safe')).toBe(before)
    }
  )

  it('cannot reach outside the meetings directory', async () => {
    const outside = path.join(artifactsDir, 'not-a-meeting.txt')
    fs.writeFileSync(outside, 'keep me', 'utf8')
    seed('m-x')

    await fetch(`${base}/meetings/..%2F..%2Fnot-a-meeting.txt`, {
      method: 'DELETE',
      headers: auth()
    })

    expect(fs.existsSync(outside)).toBe(true)
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep me')
  })

  it('requires the bridge token', async () => {
    seed('m-auth')
    const res = await fetch(`${base}/meetings/m-auth`, { method: 'DELETE' })
    expect(res.status).toBe(401)
    expect(fs.existsSync(meetingPath('m-auth'))).toBe(true)
  })
})

// AC-2 — the route this one is one path segment away from.
describe('DELETE /meetings/:id/audio is unshadowed', () => {
  it('still drops only the audio and keeps the meeting', async () => {
    seed('m-audio')
    const res = await del('/meetings/m-audio/audio')
    expect(res.status).toBe(200)

    // The meeting survives, which is the whole difference between the two routes.
    expect(fs.existsSync(meetingPath('m-audio'))).toBe(true)
    expect(fs.existsSync(path.join(meetingPath('m-audio'), 'transcript.json'))).toBe(true)
    expect(fs.existsSync(path.join(meetingPath('m-audio'), 'mic.webm'))).toBe(false)
    expect(listMeetings(artifactsDir).map((m) => m.id)).toEqual(['m-audio'])
  })

  it('and the two routes disagree about the same meeting, as they should', async () => {
    seed('m-a')
    seed('m-b')

    await del('/meetings/m-a/audio')
    await del('/meetings/m-b')

    expect(fs.existsSync(meetingPath('m-a'))).toBe(true)
    expect(fs.existsSync(meetingPath('m-b'))).toBe(false)
  })
})
