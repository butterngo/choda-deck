import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { handleAttentionRoute, workspaceForCwd } from './attention'

// TASK-2384 — GET /attention over real HTTP with a temp data dir.

const NOW = Date.parse('2026-10-11T06:00:00Z')
let dataDir: string
let server: Server
let base: string

function write(sid: string, state: string, minutesAgo: number, cwd: string): void {
  const dir = path.join(dataDir, 'attention')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${sid}.json`),
    JSON.stringify({
      sessionId: sid,
      cwd,
      state,
      since: new Date(NOW - minutesAgo * 60_000).toISOString()
    })
  )
}

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attention-route-'))
  server = createServer((req, res) => {
    handleAttentionRoute(req, res, {
      dataDir,
      now: () => NOW,
      workspaces: async () => [
        { id: 'choda-deck', cwd: 'C:/dev/choda-deck' },
        { id: 'choda-deck-companion', cwd: 'C:/dev/choda-deck-companion' }
      ]
    }).then((handled) => {
      if (!handled) {
        res.writeHead(418)
        res.end()
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('GET /attention (TASK-2384)', () => {
  it('AC-1: fresh sessions oldest first, 13 h old dropped, workspace by cwd or null', async () => {
    write('finished-1m', 'finished', 1, 'C:/dev/choda-deck')
    write('waiting-5m', 'waiting', 5, 'C:/dev/choda-deck-companion/packages/web')
    write('stale-13h', 'waiting', 13 * 60, 'C:/dev/choda-deck')
    write('unknown-2m', 'finished', 2, 'C:/dev/elsewhere')
    const res = await fetch(`${base}/attention`)
    expect(res.status).toBe(200)
    const { sessions } = (await res.json()) as {
      sessions: { sessionId: string; workspaceId: string | null; state: string }[]
    }
    expect(sessions.map((s) => s.sessionId)).toEqual(['waiting-5m', 'unknown-2m', 'finished-1m'])
    expect(sessions[0]).toMatchObject({ state: 'waiting', workspaceId: 'choda-deck-companion' })
    expect(sessions[1]?.workspaceId).toBeNull()
    expect(sessions[2]?.workspaceId).toBe('choda-deck')
  })

  it('no attention folder → 200 with an empty list', async () => {
    const res = await fetch(`${base}/attention`)
    expect(await res.json()).toEqual({ sessions: [] })
  })

  it('the longest matching workspace wins, and a sibling with a shared prefix does not match', () => {
    const ws = [
      { id: 'choda-deck', cwd: 'C:/dev/choda-deck' },
      { id: 'companion', cwd: 'C:/dev/choda-deck-companion' }
    ]
    expect(workspaceForCwd('C:/dev/choda-deck-companion/x', ws)).toBe('companion')
    expect(workspaceForCwd('C:/dev/choda-deck', ws)).toBe('choda-deck')
    expect(workspaceForCwd('C:/dev/choda-deckX', ws)).toBeNull()
  })
})
