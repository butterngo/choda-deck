import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { startCompanionServer, COMPANION_BIND, type CompanionServerHandle } from './http-server'
import type { CompanionServices } from './service-factory'
import { parseRange } from './activity'

// TASK-2152 — the route through the real adapter server, over real HTTP, with
// digests on disk in a temp artifactsDir.

let tmp: string
let artifactsDir: string
let handle: CompanionServerHandle
let base: string

function store(date: string, body: object = {}): void {
  const dir = path.join(artifactsDir, 'activity')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${date}.json`), JSON.stringify({ date, ...body }))
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'choda-activity-route-'))
  artifactsDir = path.join(tmp, 'artifacts')
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
    bridgeToken: 'tok',
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
  fs.rmSync(tmp, { recursive: true, force: true })
})

beforeEach(() => {
  fs.rmSync(path.join(artifactsDir, 'activity'), { recursive: true, force: true })
})

describe('GET /activity/digests — TASK-2152', () => {
  it('AC-1: returns the stored digests in the range, ascending', async () => {
    store('2026-09-25', { metrics: { prompts: 111 } })
    store('2026-09-24')
    store('2026-09-26') // outside the range
    const res = await fetch(`${base}/activity/digests?from=2026-09-24&to=2026-09-25`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { date: string }[]
    expect(body.map((d) => d.date)).toEqual(['2026-09-24', '2026-09-25'])
  })

  it('AC-2: dates with no file are omitted, not null-filled', async () => {
    store('2026-09-25')
    const res = await fetch(`${base}/activity/digests?from=2026-09-23&to=2026-09-25`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as unknown[]
    expect(body).toHaveLength(1)
  })

  it('AC-3: an impossible date is a 400 with an error message', async () => {
    const res = await fetch(`${base}/activity/digests?from=2026-13-01`)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: unknown }
    expect(typeof body.error).toBe('string')
    expect((body.error as string).length).toBeGreaterThan(0)
  })

  it('AC-4: from after to is a 400', async () => {
    const res = await fetch(`${base}/activity/digests?from=2026-09-26&to=2026-09-25`)
    expect(res.status).toBe(400)
  })

  it('AC-5: no activity dir yet → 200 with []', async () => {
    const res = await fetch(`${base}/activity/digests`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('a corrupt digest file is skipped, not a 500', async () => {
    store('2026-09-25')
    fs.writeFileSync(path.join(artifactsDir, 'activity', '2026-09-24.json'), '{half')
    const res = await fetch(`${base}/activity/digests?from=2026-09-24&to=2026-09-25`)
    expect(res.status).toBe(200)
    expect(((await res.json()) as unknown[]).length).toBe(1)
  })

  it('2026-02-30 is rejected as not a real date', async () => {
    const res = await fetch(`${base}/activity/digests?to=2026-02-30`)
    expect(res.status).toBe(400)
  })

  it('AC-6: the route module never references the transcripts directory', () => {
    const src = fs.readFileSync(path.join(__dirname, 'activity.ts'), 'utf8')
    expect(src.includes('.claude')).toBe(false)
  })
})

describe('parseRange defaults', () => {
  it('defaults to a 30-day window ending today', () => {
    expect(parseRange(new URLSearchParams(), '2026-09-26')).toEqual({
      from: '2026-08-28',
      to: '2026-09-26'
    })
  })
})
