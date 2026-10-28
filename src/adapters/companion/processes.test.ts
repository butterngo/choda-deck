import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { EventEmitter } from 'events'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import {
  cmdlineInWorkspace,
  createProcessesRoute,
  LISTER_TIMEOUT_MS,
  type ListerChild,
  type RawSnapshot
} from './processes'

// TASK-2856 — GET /processes over real HTTP with a fake lister child, a fake
// clock and a temp workspace dir.

let wsDir: string
let server: Server
let base: string
let clock: number
let snapshot: RawSnapshot | 'hang'
let spawned: number
let killSpy: ReturnType<typeof vi.fn>

function fakeChild(): ListerChild {
  spawned += 1
  const child = new EventEmitter() as EventEmitter & ListerChild
  const stdout = new EventEmitter()
  ;(child as { stdout: unknown }).stdout = stdout
  child.kill = killSpy
  if (snapshot !== 'hang') {
    const out = JSON.stringify(snapshot)
    setImmediate(() => {
      stdout.emit('data', Buffer.from(out))
      child.emit('close')
    })
  }
  return child
}

function proc(pid: number, cmdline: string, workingSet = 50 * 1024 * 1024): RawSnapshot['processes'][0] {
  return { pid, ppid: 1, name: 'node.exe', cmdline, workingSet }
}

beforeEach(async () => {
  wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'processes-ws-'))
  clock = 1_000_000
  spawned = 0
  killSpy = vi.fn()
  snapshot = { processes: [], listeners: [] }
  const route = createProcessesRoute({ spawnLister: fakeChild, now: () => clock })
  const findWorkspace = async (id: string): Promise<{ id: string; cwd: string } | null> =>
    id === 'X' ? { id: 'X', cwd: wsDir } : null
  server = createServer((req, res) => {
    void route(req, res, findWorkspace).then((handled) => {
      if (!handled) {
        res.writeHead(404)
        res.end()
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  vi.useRealTimers()
  await new Promise<void>((r) => server.close(() => r()))
  fs.rmSync(wsDir, { recursive: true, force: true })
})

async function get(ws = 'X'): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${base}/processes?workspaceId=${ws}`)
  return { status: r.status, body: await r.json() }
}

describe('GET /processes', () => {
  it("AC-1 lists exactly the processes whose command line names the workspace cwd", async () => {
    snapshot = {
      processes: [
        proc(10, `node "${wsDir}\\dist\\a.cjs"`),
        proc(11, `dotnet run --project ${wsDir}\\src\\Api`),
        proc(12, 'node C:\\elsewhere\\x.js')
      ],
      listeners: [{ pid: 10, port: 7337 }]
    }
    const { status, body } = await get()
    expect(status).toBe(200)
    const rows = body.processes as Record<string, unknown>[]
    expect(rows.map((r) => r.pid)).toEqual([10, 11])
    expect(rows[0]).toMatchObject({ pid: 10, ppid: 1, name: 'node.exe', memoryMb: 50, ports: [7337] })
    expect(rows[1]).toMatchObject({ ports: [] })
  })

  it('AC-2 the cmdline field of a process started with --password=abc does not contain abc', async () => {
    snapshot = {
      processes: [proc(10, `node ${wsDir}\\server.js --password=abc`)],
      listeners: []
    }
    const { body } = await get()
    const row = (body.processes as { cmdline: string }[])[0]
    expect(row.cmdline).not.toContain('abc')
  })

  it('AC-3 a lister that does not answer within 5 s → 504 and the child was killed', async () => {
    snapshot = 'hang'
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pending = get()
    await vi.waitFor(() => expect(spawned).toBe(1))
    vi.advanceTimersByTime(LISTER_TIMEOUT_MS)
    const { status, body } = await pending
    expect(status).toBe(504)
    expect(body).toEqual({ error: 'process list timed out' })
    expect(killSpy).toHaveBeenCalledTimes(1)
  })

  it('AC-4 a declared launchSettings port is listening:false until something listens on it', async () => {
    const props = path.join(wsDir, 'src', 'Api', 'Properties')
    fs.mkdirSync(props, { recursive: true })
    fs.writeFileSync(
      path.join(props, 'launchSettings.json'),
      JSON.stringify({ profiles: { http: { applicationUrl: 'http://localhost:5267' } } })
    )
    snapshot = { processes: [], listeners: [] }
    expect((await get()).body.expectedPorts).toEqual([
      { port: 5267, project: 'Api', listening: false }
    ])
    clock += 11_000
    snapshot = { processes: [], listeners: [{ pid: 99, port: 5267 }] }
    expect((await get()).body.expectedPorts).toEqual([
      { port: 5267, project: 'Api', listening: true }
    ])
  })

  it('AC-5 an unknown workspace → 404 unknown workspace', async () => {
    const { status, body } = await get('nope')
    expect(status).toBe(404)
    expect(body).toEqual({ error: 'unknown workspace' })
  })

  it('AC-6 the snapshot is reused for 10 s and re-read after', async () => {
    await get()
    clock += 2_000
    await get()
    expect(spawned).toBe(1)
    clock += 9_000
    await get()
    expect(spawned).toBe(2)
  })
})

describe('cmdlineInWorkspace', () => {
  it('does not put a sibling repo with a longer name under the workspace', () => {
    expect(cmdlineInWorkspace('node C:\\dev\\choda-deck-companion\\x.js', 'C:\\dev\\choda-deck')).toBe(false)
  })
  it('accepts forward slashes, any case and a run worktree', () => {
    expect(cmdlineInWorkspace('node c:/dev/choda-deck/dist/a.cjs', 'C:\\dev\\choda-deck')).toBe(true)
    expect(
      cmdlineInWorkspace('node C:\\dev\\choda-deck.worktrees\\autopilot-TASK-1\\a.js', 'C:\\dev\\choda-deck')
    ).toBe(true)
  })
})
