import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { SqliteTaskService } from '../../core/domain/sqlite-task-service'
import {
  acceptanceCounts,
  handleRunsRoute,
  noticeKind,
  runState,
  type Run,
  type RunItem,
  type RunNotice
} from './runs'

// TASK-2531 — GET /runs over real HTTP and a real SQLite service.

const TOKEN = 'tok'
let tmp: string
let svc: SqliteTaskService
let server: Server
let base: string

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-'))
  svc = new SqliteTaskService(path.join(tmp, 'test.db'))
  await svc.ensureProject('p', 'P', tmp)
  await svc.addWorkspace('p', 'web', 'Web', tmp)
  server = createServer((req, res) => {
    handleRunsRoute(req, res, { svc, bridgeToken: TOKEN }).then((handled) => {
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
  await svc.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

function get(p: string, token = TOKEN): Promise<Response> {
  return fetch(base + p, { headers: token ? { 'x-choda-bridge-token': token } : {} })
}

const BODY = [
  '## Context',
  'x',
  '',
  '## Acceptance',
  '- [x] AC-1: route returns 200',
  '- [x] AC-2: archived notices count',
  '- [ ] AC-3: unit test covers state',
  '- [ ] AC-4: Butter sees the run in the installed app — human',
  '',
  '## Test Plan',
  '- [ ] not a criterion',
  ''
].join('\n')

async function notice(content: string, archive = false): Promise<string> {
  const n = await svc.createInbox({ projectId: 'p', workspaceId: 'web', content })
  if (archive) await svc.archiveInbox(n.id, 'read')
  await tick()
  return n.id
}

describe('GET /runs', () => {
  it('AC-1/AC-2: one run per goal, archived notices included, unplaced notices apart', async () => {
    await svc.createTask({ id: 'TASK-10', projectId: 'p', title: 'Goal A', status: 'READY' })
    await svc.createTask({ id: 'TASK-11', projectId: 'p', parentTaskId: 'TASK-10', title: 'Item one', body: BODY })
    await svc.createTask({ id: 'TASK-20', projectId: 'p', title: 'Goal B', status: 'READY' })
    await svc.createTask({ id: 'TASK-21', projectId: 'p', parentTaskId: 'TASK-20', title: 'Item two' })

    const started = await notice('[loop:web] ⚪ run TASK-20 started: 1 tasks, 0 inbox, 0 excluded')
    const startedA = await notice('[loop:web] ⚪ run TASK-10 started: 1 tasks', true)
    const haltA = await notice('[loop:web] 🔴 run TASK-10 halted: build gate cannot run')
    const loose = await notice('[loop:main] 🔴 run: unfamiliar dirty tree\n M a.ts')
    await notice('buy milk')

    const res = await get('/runs')
    expect(res.status).toBe(200)
    const { runs, otherNotices } = (await res.json()) as { runs: Run[]; otherNotices: RunNotice[] }

    // Newest activity first: TASK-10's halt is newer than TASK-20's start.
    expect(runs.map((r) => r.goal.id)).toEqual(['TASK-10', 'TASK-20'])
    const a = runs[0]
    expect(a.goal).toEqual({ id: 'TASK-10', title: 'Goal A', status: 'READY', projectId: 'p' })
    expect(a.notices.map((n) => n.id)).toEqual([startedA, haltA])
    expect(a.notices[0].status).toBe('archived')
    expect(a.notices[1]).toMatchObject({ kind: 'blocked', title: '🔴 run TASK-10 halted: build gate cannot run' })
    expect(a.state).toBe('halted')
    expect(a.lastActivityAt).toBe(a.notices[1].createdAt)
    expect(runs[1].notices.map((n) => n.id)).toEqual([started])
    expect(otherNotices.map((n) => n.id)).toEqual([loose])
  })

  it('AC-3: an item carries its AC counts, newest handoff commit and tests, and an active session', async () => {
    await svc.createTask({ id: 'TASK-10', projectId: 'p', title: 'Goal', status: 'READY' })
    await svc.createTask({ id: 'TASK-11', projectId: 'p', parentTaskId: 'TASK-10', title: 'Done item', body: BODY, status: 'IMPLEMENTED' })
    await svc.createTask({ id: 'TASK-12', projectId: 'p', parentTaskId: 'TASK-10', title: 'Busy item', status: 'IN-PROGRESS' })
    await svc.createTask({ id: 'TASK-13', projectId: 'p', parentTaskId: 'TASK-10', title: 'Waiting item' })

    const old = await svc.createSession({ projectId: 'p', workspaceId: 'web', taskId: 'TASK-11', startedAt: '2026-10-19T08:00:00.000Z' })
    await svc.updateSession(old.id, { status: 'completed', endedAt: '2026-10-19T08:10:00.000Z', handoff: { commits: ['1111111 old try (TASK-11)'] } })
    const done = await svc.createSession({ projectId: 'p', workspaceId: 'web', taskId: 'TASK-11', startedAt: '2026-10-19T09:00:00.000Z' })
    await svc.updateSession(done.id, {
      status: 'completed',
      endedAt: '2026-10-19T09:20:00.000Z',
      handoff: { commits: ['7061794 feat: item (TASK-11)'], testResults: { passed: ['ServiceActorTests 4/4'], skipped: ['e2e: no env'] } }
    })
    await svc.createSession({ projectId: 'p', workspaceId: 'web', taskId: 'TASK-12', startedAt: '2026-10-19T10:29:00.000Z' })
    await notice('[loop:web] 🔴 run TASK-10 halted: NuGet restore fails')

    const { runs } = (await (await get('/runs')).json()) as { runs: Run[] }
    const [i11, i12, i13] = runs[0].items
    expect(i11).toEqual({
      id: 'TASK-11',
      title: 'Done item',
      status: 'IMPLEMENTED',
      ac: { ticked: 2, total: 4, humanOpen: ['AC-4: Butter sees the run in the installed app — human'] },
      commit: '7061794 feat: item (TASK-11)',
      tests: { passed: ['ServiceActorTests 4/4'], skipped: ['e2e: no env'] },
      activeSince: null
    })
    expect(i12).toMatchObject({ id: 'TASK-12', commit: null, tests: null, activeSince: '2026-10-19T10:29:00.000Z' })
    expect(i13).toMatchObject({ id: 'TASK-13', ac: { ticked: 0, total: 0, humanOpen: [] }, activeSince: null })
    // The TASK-2513 case: newest notice is a halt, but an item is being worked.
    expect(runs[0].state).toBe('running')
  })

  it('attaches an item-level notice to the run that owns the item', async () => {
    await svc.createTask({ id: 'TASK-10', projectId: 'p', title: 'Goal', status: 'READY' })
    await svc.createTask({ id: 'TASK-11', projectId: 'p', parentTaskId: 'TASK-10', title: 'Item' })
    await notice('[loop:web] ⚪ run TASK-10 started: 1 tasks')
    const blocked = await notice('[loop:web] 🔴 TASK-11 blocked: test failed twice\nwork saved in stash autopilot-blocked-TASK-11')
    const { runs, otherNotices } = (await (await get('/runs')).json()) as { runs: Run[]; otherNotices: RunNotice[] }
    expect(runs[0].notices.map((n) => n.id)).toContain(blocked)
    expect(otherNotices).toEqual([])
  })

  it('AC-5: 401 without the bridge token, 405 on POST, not handled elsewhere', async () => {
    expect((await get('/runs', '')).status).toBe(401)
    expect((await get('/runs', 'wrong')).status).toBe(401)
    expect((await fetch(base + '/runs', { method: 'POST', headers: { 'x-choda-bridge-token': TOKEN } })).status).toBe(405)
    expect((await get('/runsx')).status).toBe(418)
  })
})

describe('acceptanceCounts', () => {
  it('AC-3: counts only the Acceptance section and lists unticked human criteria', () => {
    expect(acceptanceCounts(BODY)).toEqual({
      ticked: 2,
      total: 4,
      humanOpen: ['AC-4: Butter sees the run in the installed app — human']
    })
    expect(acceptanceCounts(null)).toEqual({ ticked: 0, total: 0, humanOpen: [] })
    expect(acceptanceCounts('## Acceptance (khi nào làm)\n- [X] done\n- [ ] open')).toEqual({ ticked: 1, total: 2, humanOpen: [] })
  })
})

describe('runState', () => {
  const item = (activeSince: string | null): RunItem => ({
    id: 'TASK-1',
    title: 't',
    status: 'TODO',
    ac: { ticked: 0, total: 0, humanOpen: [] },
    commit: null,
    tests: null,
    activeSince
  })
  const n = (text: string, at: string): RunNotice => ({
    id: at,
    workspaceId: null,
    kind: noticeKind(text),
    title: text,
    content: text,
    createdAt: at,
    status: 'raw'
  })

  it('AC-4: all five states, sessions before notices', () => {
    const start = n('⚪ run TASK-1 started', '1')
    expect(runState([item(null)], [start, n('⚪ run TASK-1 finished\nDONE: TASK-2', '2')])).toBe('finished')
    expect(runState([item(null)], [start, n('🔴 run TASK-1 halted: x', '2')])).toBe('halted')
    expect(runState([item(null)], [start, n('🟢 run TASK-1 ready: 2 items', '2')])).toBe('waiting-merge')
    expect(runState([item(null)], [start])).toBe('idle')
    expect(runState([item('2026-10-19T10:29:00Z')], [start, n('🔴 run TASK-1 halted: x', '2')])).toBe('running')
  })

  it('uses the newest notice regardless of input order', () => {
    expect(runState([item(null)], [n('🟢 run TASK-1 ready', '3'), n('🔴 run TASK-1 halted', '2')])).toBe('waiting-merge')
  })
})

describe('noticeKind', () => {
  it('reads the leading emoji', () => {
    expect(noticeKind('🟡 TASK-1 needs a decision')).toBe('decision')
    expect(noticeKind('plain text')).toBe('other')
  })
})
