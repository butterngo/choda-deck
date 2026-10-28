import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { handleAgentsRoute, transcriptActivity, type AgentsDeps } from './agents'
import { cwdToProjectSlug } from '../../core/domain/session-transcript'

// TASK-2855 — GET /agents over real HTTP with a temp home dir and a fake
// start-time reader standing in for the process table.

const NOW = Date.parse('2026-10-28T10:00:00Z')
const CWD = 'C:\\dev\\choda-deck'
let homeDir: string
let dataDir: string
let server: Server
let base: string
let startTimes: Map<number, string>

function writeRegistry(file: string, body: unknown): void {
  const dir = path.join(homeDir, '.claude', 'sessions')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, file), typeof body === 'string' ? body : JSON.stringify(body))
}

function registry(pid: number, sessionId: string, procStart: string, status = 'busy'): unknown {
  return {
    pid,
    sessionId,
    cwd: CWD,
    name: `agent-${pid}`,
    kind: 'interactive',
    status,
    procStart,
    statusUpdatedAt: NOW - 60_000
  }
}

function writeAttention(sessionId: string, state: string, since: string): void {
  const dir = path.join(dataDir, 'attention')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${sessionId}.json`),
    JSON.stringify({ sessionId, cwd: CWD, state, since })
  )
}

async function get(): Promise<{
  status: number
  body: { agents: Record<string, unknown>[]; unreadable: number }
}> {
  const r = await fetch(`${base}/agents`)
  return { status: r.status, body: await r.json() }
}

beforeEach(async () => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-home-'))
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-data-'))
  startTimes = new Map()
  const deps: AgentsDeps = {
    dataDir,
    homeDir,
    workspaces: async () => [{ id: 'main', cwd: CWD }],
    readStartTimes: async (pids) =>
      new Map([...startTimes].filter(([pid]) => pids.includes(pid))),
    now: () => NOW
  }
  server = createServer((req, res) => {
    void handleAgentsRoute(req, res, deps).then((handled) => {
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
  await new Promise<void>((r) => server.close(() => r()))
  fs.rmSync(homeDir, { recursive: true, force: true })
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('GET /agents', () => {
  it('AC-1 lists the session whose pid is alive and drops the one whose pid is dead', async () => {
    writeRegistry('100.json', registry(100, 'live', '111'))
    writeRegistry('200.json', registry(200, 'dead', '222'))
    startTimes.set(100, '111')
    const { status, body } = await get()
    expect(status).toBe(200)
    expect(body.agents.map((a) => a.sessionId)).toEqual(['live'])
  })

  it('AC-2 drops a file whose pid is running but started at a different time (pid reused)', async () => {
    writeRegistry('100.json', registry(100, 'reused', '111'))
    startTimes.set(100, '999')
    const { body } = await get()
    expect(body.agents).toEqual([])
  })

  it('AC-3 a waiting attention file overrides the registry status and gives its since', async () => {
    writeRegistry('100.json', registry(100, 'waits', '111', 'idle'))
    writeRegistry('101.json', registry(101, 'works', '112', 'busy'))
    startTimes.set(100, '111')
    startTimes.set(101, '112')
    const since = new Date(NOW - 5 * 60_000).toISOString()
    writeAttention('waits', 'waiting', since)
    const { body } = await get()
    const bySid = new Map(body.agents.map((a) => [a.sessionId, a]))
    expect(bySid.get('waits')).toMatchObject({ status: 'waiting', since })
    expect(bySid.get('works')).toMatchObject({ status: 'busy' })
  })

  it('AC-4 counts a non-JSON file and a file without pid as unreadable and still lists the rest', async () => {
    writeRegistry('100.json', registry(100, 'ok', '111'))
    writeRegistry('bad.json', '{ not json')
    writeRegistry('nopid.json', { sessionId: 'x' })
    startTimes.set(100, '111')
    const { status, body } = await get()
    expect(status).toBe(200)
    expect(body.unreadable).toBe(2)
    expect(body.agents.map((a) => a.sessionId)).toEqual(['ok'])
  })

  it('AC-5 reads the last tool, the last activity and the subagent count from the transcript', async () => {
    writeRegistry('100.json', registry(100, 'sess', '111'))
    startTimes.set(100, '111')
    const projectDir = path.join(homeDir, '.claude', 'projects', cwdToProjectSlug(CWD))
    fs.mkdirSync(path.join(projectDir, 'sess', 'subagents'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'sess', 'subagents', 'a.jsonl'), '')
    fs.writeFileSync(path.join(projectDir, 'sess', 'subagents', 'b.jsonl'), '')
    const rows = [
      { type: 'user', timestamp: '2026-10-28T09:00:00.000Z', message: { content: 'hi' } },
      {
        type: 'assistant',
        timestamp: '2026-10-28T09:01:00.000Z',
        message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] }
      },
      {
        type: 'assistant',
        timestamp: '2026-10-28T09:02:00.000Z',
        message: { content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', name: 'Bash', input: {} }] }
      }
    ]
    fs.writeFileSync(
      path.join(projectDir, 'sess.jsonl'),
      rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
    )
    const { body } = await get()
    expect(body.agents[0]).toMatchObject({
      lastTool: 'Bash',
      subagents: 2,
      lastActivityAt: '2026-10-28T09:02:00.000Z',
      workspaceId: 'main'
    })
  })

  it('maps a session working in an autopilot worktree to its workspace', async () => {
    writeRegistry('100.json', {
      ...(registry(100, 'run', '111') as object),
      cwd: 'C:\\dev\\choda-deck.worktrees\\autopilot-TASK-1'
    })
    startTimes.set(100, '111')
    const { body } = await get()
    expect(body.agents[0]).toMatchObject({ workspaceId: 'main' })
  })

  it('returns an empty list when there is no sessions dir', async () => {
    const { status, body } = await get()
    expect(status).toBe(200)
    expect(body).toEqual({ agents: [], unreadable: 0 })
  })
})

describe('transcriptActivity', () => {
  it('skips a cut first line from a tail read', () => {
    const tail = 'ype":"user"}\n' + JSON.stringify({ type: 'user', timestamp: 'T1' })
    expect(transcriptActivity(tail)).toEqual({ lastActivityAt: 'T1', lastTool: null })
  })
})
