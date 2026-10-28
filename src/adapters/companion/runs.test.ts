import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { SqliteTaskService } from '../../core/domain/sqlite-task-service'
import type { AttentionSession } from './attention'
import {
  acceptanceCounts,
  buildRuns,
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
      commits: [
        { sha: '7061794', subject: 'feat: item (TASK-11)', workspaceId: 'web', sessionId: done.id },
        { sha: '1111111', subject: 'old try (TASK-11)', workspaceId: 'web', sessionId: old.id }
      ],
      tests: { passed: ['ServiceActorTests 4/4'], skipped: ['e2e: no env'] },
      activeSince: null,
      deps: [],
      // TASK-2597 — BODY's two ticked criteria are untagged (covered), AC-3 is open, AC-4 human.
      acs: expect.any(Array),
      sequence: null,
      coverage: { covered: 2, weak: 0, open: 1, human: 1, total: 4 }
    })
    expect(i12).toMatchObject({ id: 'TASK-12', commit: null, tests: null, activeSince: '2026-10-19T10:29:00.000Z' })
    expect(i13).toMatchObject({ id: 'TASK-13', ac: { ticked: 0, total: 0, humanOpen: [] }, activeSince: null })
    // The TASK-2513 case: newest notice is a halt, but an item is being worked.
    expect(runs[0].state).toBe('running')
  })

  // TASK-2560 — every commit of every session, each with its own workspace.
  describe('item commits', () => {
    async function twoSessions(): Promise<RunItem[]> {
      await svc.addWorkspace('p', 'w-new', 'New', tmp)
      await svc.addWorkspace('p', 'w-old', 'Old', tmp)
      await svc.createTask({ id: 'TASK-10', projectId: 'p', title: 'Goal', status: 'READY' })
      await svc.createTask({ id: 'TASK-11', projectId: 'p', parentTaskId: 'TASK-10', title: 'Item', status: 'IMPLEMENTED' })
      await svc.createTask({ id: 'TASK-12', projectId: 'p', parentTaskId: 'TASK-10', title: 'Untouched' })
      const older = await svc.createSession({ projectId: 'p', workspaceId: 'w-old', taskId: 'TASK-11', startedAt: '2026-10-19T08:00:00.000Z' })
      await svc.updateSession(older.id, {
        status: 'completed',
        endedAt: '2026-10-19T08:10:00.000Z',
        handoff: { commits: ['a1a1a1a zero', 'b1b1b1b one again'] }
      })
      const newer = await svc.createSession({ projectId: 'p', workspaceId: 'w-new', taskId: 'TASK-11', startedAt: '2026-10-19T09:00:00.000Z' })
      await svc.updateSession(newer.id, {
        status: 'completed',
        endedAt: '2026-10-19T09:10:00.000Z',
        handoff: { commits: ['b2b2b2b two', 'b1b1b1b one'] }
      })
      await notice('[loop:web] ⚪ run TASK-10 started: 2 tasks')
      return ((await (await get('/runs')).json()) as { runs: Run[] }).runs[0].items
    }

    it('AC-1: serves items[0].commits newest session first, stored order within one', async () => {
      const items = await twoSessions()
      expect(items[0].commits.map((c) => c.sha)).toEqual(['b2b2b2b', 'b1b1b1b', 'a1a1a1a'])
    })

    it('AC-2: the a1a1a1a entry carries the older session workspace', async () => {
      const items = await twoSessions()
      expect(items[0].commits.find((c) => c.sha === 'a1a1a1a')?.workspaceId).toBe('w-old')
    })

    it('AC-3: the a1a1a1a entry has subject "zero"', async () => {
      const items = await twoSessions()
      expect(items[0].commits.find((c) => c.sha === 'a1a1a1a')?.subject).toBe('zero')
    })

    it('AC-4: the b2b2b2b entry carries the newer session workspace', async () => {
      const items = await twoSessions()
      expect(items[0].commits.find((c) => c.sha === 'b2b2b2b')?.workspaceId).toBe('w-new')
    })

    it('AC-5: a sha in both handoffs appears once, from the newer session', async () => {
      const items = await twoSessions()
      const b1 = items[0].commits.filter((c) => c.sha === 'b1b1b1b')
      expect(b1).toHaveLength(1)
      expect(b1[0].subject).toBe('one')
    })

    it('AC-6: commit is unchanged, the first commit of the newest handoff', async () => {
      const items = await twoSessions()
      expect(items[0].commit).toBe('b2b2b2b two')
    })

    it('AC-7: an item with no session serves commits: []', async () => {
      const items = await twoSessions()
      expect(items[1].commits).toEqual([])
    })
  })

  // TASK-2597 — each item's criteria with how they were proven, its diagram and coverage.
  describe('run item criteria', () => {
    // AC-0 — test, ticked with method test ref X
    // AC-1 — test, ticked by a legacy call with no method (body pre-ticked, event without method)
    // AC-2 — test, unchecked
    // AC-3 — human, unchecked
    // AC-4 — test, ticked in an older session ref A and again in a newer session ref B
    const FIXTURE = [
      '## Acceptance',
      '- [ ] route serves acs — test',
      '- [x] legacy tick — test',
      '- [ ] not done yet — test',
      '- [ ] Butter sees it — human',
      '- [ ] re-proven later — test',
      '',
      '## Test Plan',
      '- none',
      ''
    ].join('\n')

    async function rawTick(sessionId: string, acIndex: number, extra: Record<string, unknown>): Promise<void> {
      await svc.createSessionEvent({
        sessionId,
        eventType: 'observation',
        payloadJson: JSON.stringify({ kind: 'ac_check', taskId: 'TASK-11', acIndex, text: 't', evidence: 'e', sessionId, ...extra })
      })
      await tick()
    }

    async function fixtureItem(): Promise<RunItem> {
      await svc.createTask({ id: 'TASK-10', projectId: 'p', title: 'Goal', status: 'READY' })
      await svc.createTask({ id: 'TASK-11', projectId: 'p', parentTaskId: 'TASK-10', title: 'Item', body: FIXTURE })
      const older = (
        await svc.createSession({ projectId: 'p', workspaceId: 'web', taskId: 'TASK-11', startedAt: '2026-10-19T08:00:00.000Z' })
      ).id
      await rawTick(older, 1, {})
      await rawTick(older, 4, { method: 'test', ref: 'A' })
      await svc.updateSession(older, { status: 'completed', endedAt: '2026-10-19T08:10:00.000Z' })
      const newer = (
        await svc.createSession({ projectId: 'p', workspaceId: 'web', taskId: 'TASK-11', startedAt: '2026-10-19T09:00:00.000Z' })
      ).id
      await svc.checkAcItem({ taskId: 'TASK-11', acIndex: 0, evidence: 'e', workspaceId: 'web', method: 'test', ref: 'X' })
      await tick()
      await svc.checkAcItem({ taskId: 'TASK-11', acIndex: 4, evidence: 'e', workspaceId: 'web', method: 'test', ref: 'B' })
      expect(newer).not.toBe(older)
      await notice('[loop:web] ⚪ run TASK-10 started: 1 tasks')
      const runs = ((await (await get('/runs')).json()) as { runs: Run[] }).runs
      return runs[0].items[0]
    }

    it('AC-0: a criterion ticked with method test serves state "covered"', async () => {
      expect((await fixtureItem()).acs[0].state).toBe('covered')
    })

    it('AC-1: that criterion serves ref "X"', async () => {
      expect((await fixtureItem()).acs[0].ref).toBe('X')
    })

    it('AC-2: a legacy tick with no method on a tagged criterion serves "weak"', async () => {
      expect((await fixtureItem()).acs[1].state).toBe('weak')
    })

    it('AC-3: an unchecked test criterion serves "open"', async () => {
      expect((await fixtureItem()).acs[2].state).toBe('open')
    })

    it('AC-4: an unchecked human criterion serves "human"', async () => {
      expect((await fixtureItem()).acs[3].state).toBe('human')
    })

    it('AC-5: the newest tick of an index wins — ref "B", not "A"', async () => {
      const item = await fixtureItem()
      expect(item.acs[4].ref).toBe('B')
      expect(item.acs[4].state).toBe('covered')
    })

    it('AC-6: coverage counts the fixture as 2 covered, 1 weak, 1 open, 1 human of 5', async () => {
      expect((await fixtureItem()).coverage).toEqual({ covered: 2, weak: 1, open: 1, human: 1, total: 5 })
    })

    it('rows carry index, text, tag and method', async () => {
      const row = (await fixtureItem()).acs[0]
      expect(row).toMatchObject({ index: 0, text: 'route serves acs — test', tag: 'test', checked: true, method: 'test' })
    })

    async function sequenceOf(body: string): Promise<RunItem['sequence']> {
      await svc.createTask({ id: 'TASK-10', projectId: 'p', title: 'Goal', status: 'READY' })
      await svc.createTask({ id: 'TASK-11', projectId: 'p', parentTaskId: 'TASK-10', title: 'Item', body })
      await notice('[loop:web] ⚪ run TASK-10 started: 1 tasks')
      const runs = ((await (await get('/runs')).json()) as { runs: Run[] }).runs
      return runs[0].items[0].sequence
    }

    it('AC-7: a ## Sequence mermaid fence serves sequence.mermaid equal to the fence text', async () => {
      const fence = 'sequenceDiagram\n  participant W as Web\n  W->>A: GET /runs'
      const body = `## Context\n\nx\n\n## Sequence\n\n\`\`\`mermaid\n${fence}\n\`\`\`\n\n## Acceptance\n\n- [ ] a — test\n`
      expect(await sequenceOf(body)).toEqual({ mermaid: fence })
    })

    it('AC-8: "Sequence: n/a — docs only" serves { na: "docs only" }', async () => {
      expect(await sequenceOf('## Context\n\nx\n\nSequence: n/a — docs only\n\n## Acceptance\n\n- [ ] a — grep\n')).toEqual({
        na: 'docs only'
      })
    })

    it('AC-9: a body with neither serves sequence: null', async () => {
      expect(await sequenceOf('## Context\n\nx\n\n## Acceptance\n\n- [ ] a\n')).toBeNull()
    })

    it('a mermaid fence outside ## Sequence is not the item diagram', async () => {
      const body = '## Context\n\n```mermaid\nflowchart TB\n  A-->B\n```\n\n## Acceptance\n\n- [ ] a\n'
      expect(await sequenceOf(body)).toBeNull()
    })
  })

  // TASK-2590 — the feature the goal realizes.
  describe('run feature', () => {
    async function goalRun(): Promise<Run> {
      await notice('[loop:web] ⚪ run TASK-10 started: 0 tasks')
      return ((await (await get('/runs')).json()) as { runs: Run[] }).runs[0]
    }
    async function feature(title: string, body: string): Promise<string> {
      return (await svc.createKnowledge({ projectId: 'p', type: 'feature', scope: 'project', title, body, refs: [] })).slug
    }

    beforeEach(async () => {
      await svc.createTask({ id: 'TASK-10', projectId: 'p', title: 'Goal', status: 'READY' })
    })

    it('AC-1: a goal with no REALIZES edge serves feature: null', async () => {
      expect((await goalRun()).feature).toBeNull()
    })

    it('AC-2: why is the first paragraph under ## Why this exists', async () => {
      const slug = await feature('BPA x WorkHub', '## Context\n\nTechnical.\n\n## Why this exists\n\nAlpha beta.\n\nSecond.\n')
      await svc.addRelationship('TASK-10', slug, 'REALIZES')
      expect((await goalRun()).feature?.why).toBe('Alpha beta.')
    })

    it('AC-3: title is the entry title and missing is false', async () => {
      const slug = await feature('BPA x WorkHub', '## Why this exists\n\nAlpha beta.\n')
      await svc.addRelationship('TASK-10', slug, 'REALIZES')
      expect((await goalRun()).feature).toMatchObject({ slug, title: 'BPA x WorkHub', missing: false })
    })

    it('AC-4: without the section, why is the body first paragraph', async () => {
      const slug = await feature('Plain', 'Opening line\nsame paragraph.\n\nLater.\n')
      await svc.addRelationship('TASK-10', slug, 'REALIZES')
      expect((await goalRun()).feature?.why).toBe('Opening line same paragraph.')
    })

    it('AC-5: a 600-character paragraph is cut to at most 401 characters ending with …', async () => {
      const long = Array.from({ length: 100 }, () => 'word5').join(' ')
      expect(long.length).toBeGreaterThan(590)
      const slug = await feature('Long', `## Why this exists\n\n${long}\n`)
      await svc.addRelationship('TASK-10', slug, 'REALIZES')
      const why = (await goalRun()).feature?.why ?? ''
      expect(why.length).toBeLessThanOrEqual(401)
      expect(why.endsWith('…')).toBe(true)
    })

    it('AC-6: an edge to a slug with no entry serves missing: true', async () => {
      await svc.addRelationship('TASK-10', 'gone', 'REALIZES')
      expect((await goalRun()).feature).toEqual({ slug: 'gone', title: 'gone', why: null, missing: true })
    })

    // TASK-2833 — getKnowledge spawns git per ref to compute staleness; it was
    // 97% of GET /runs. The card needs the text only, so the call must not happen.
    it('serves the feature without calling getKnowledge (no git staleness check)', async () => {
      const slug = await feature('BPA x WorkHub', '## Why this exists\n\nAlpha beta.\n')
      await svc.addRelationship('TASK-10', slug, 'REALIZES')
      const spy = vi.spyOn(svc, 'getKnowledge').mockRejectedValue(new Error('staleness must not run on GET /runs'))
      try {
        expect((await goalRun()).feature).toMatchObject({ slug, title: 'BPA x WorkHub', why: 'Alpha beta.', missing: false })
        expect(spy).not.toHaveBeenCalled()
      } finally {
        spy.mockRestore()
      }
    })
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

// TASK-2601 — the goal's test report, read from the home workspace's working tree.
describe('GET /runs — run report', () => {
  const runOf = async (): Promise<Run> => {
    await notice('[loop:web] ⚪ run TASK-10 started: 0 tasks')
    return ((await (await get('/runs')).json()) as { runs: Run[] }).runs[0]
  }
  const writeReport = (text: string): void => {
    fs.mkdirSync(path.join(tmp, 'docs', 'reports'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'docs', 'reports', 'task-10-test-report.md'), text)
  }
  const FM = [
    '---',
    'goal: "TASK-10"',
    'generatedAt: "2026-10-22T00:00:00.000Z"',
    'suite: {"passed":827,"skipped":1,"failed":0}',
    'testsAdded: 85',
    'unreadableCommits: []',
    'ac: {"covered":10,"weak":0,"open":0,"human":1,"total":11}',
    'smoke: null',
    'regression: []',
    '---',
    '',
    '# Test report — TASK-10',
    ''
  ].join('\n')

  beforeEach(async () => {
    await svc.createTask({ id: 'TASK-10', projectId: 'p', title: 'Goal', status: 'READY' })
  })

  it('AC-1: a goal with no report file serves report: null', async () => {
    expect((await runOf()).report).toBeNull()
  })

  it('AC-2: a report with testsAdded 85 serves report.summary.testsAdded 85', async () => {
    writeReport(FM)
    expect((await runOf()).report?.summary?.testsAdded).toBe(85)
  })

  it('AC-3: the report path is docs/reports/task-10-test-report.md in the home workspace', async () => {
    writeReport(FM)
    const report = (await runOf()).report
    expect(report?.path).toBe('docs/reports/task-10-test-report.md')
    expect(report?.workspaceId).toBe('web')
  })

  it('AC-4: a broken frontmatter block serves summary: null with the path still set', async () => {
    writeReport(FM.replace('testsAdded: 85', 'testsAdded: {broken'))
    const report = (await runOf()).report
    expect(report?.summary).toBeNull()
    expect(report?.path).toBe('docs/reports/task-10-test-report.md')
  })
})

// TASK-2607 — the goal's deploy checklist, from the same home workspace.
describe('GET /runs — deploy checklist', () => {
  const runOf = async (): Promise<Run> => {
    await notice('[loop:web] ⚪ run TASK-10 started: 0 tasks')
    return ((await (await get('/runs')).json()) as { runs: Run[] }).runs[0]
  }
  const ITEMS = [
    { key: 'sql:docs/deploy/sql/x-all.sql', phase: 'before', kind: 'sql', title: 'Run x-all.sql', why: 'w', workspaceId: 'web', file: 'docs/deploy/sql/x-all.sql' },
    { key: 'migration:1_A', phase: 'before', kind: 'migration', title: 'Apply 1_A', why: 'w', workspaceId: 'web' },
    { key: 'endpoint:GET /x', phase: 'after', kind: 'endpoint', title: 'Check GET /x', why: 'w', workspaceId: 'web' }
  ]

  beforeEach(async () => {
    await svc.createTask({ id: 'TASK-10', projectId: 'p', title: 'Goal', status: 'READY' })
  })

  it('AC-1: a goal with a checklist file serves deploy.items in the frontmatter order', async () => {
    fs.mkdirSync(path.join(tmp, 'docs', 'reports'), { recursive: true })
    fs.writeFileSync(
      path.join(tmp, 'docs', 'reports', 'task-10-deploy-checklist.md'),
      `---\ngoal: "TASK-10"\nitems: ${JSON.stringify(ITEMS)}\n---\n\n# Deploy checklist — TASK-10\n`
    )
    const deploy = (await runOf()).deploy
    expect(deploy?.items?.map((i) => i.key)).toEqual(ITEMS.map((i) => i.key))
    expect(deploy?.path).toBe('docs/reports/task-10-deploy-checklist.md')
    expect(deploy?.workspaceId).toBe('web')
  })

  it('AC-2: a goal without one serves deploy: null', async () => {
    expect((await runOf()).deploy).toBeNull()
  })

  it('a broken frontmatter serves items: null with the path kept', async () => {
    fs.mkdirSync(path.join(tmp, 'docs', 'reports'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'docs', 'reports', 'task-10-deploy-checklist.md'), '---\nitems: [broken\n---\n')
    const deploy = (await runOf()).deploy
    expect(deploy?.items).toBeNull()
    expect(deploy?.path).toBe('docs/reports/task-10-deploy-checklist.md')
  })
})

// TASK-2535 — the fields the v2 Runs screen draws from: the flow, the stepper,
// the PR link and the project heading.
describe('GET /runs — TASK-2535 fields', () => {
  const runsOf = async (): Promise<Run[]> => ((await (await get('/runs')).json()) as { runs: Run[] }).runs
  const byGoal = (runs: Run[], id: string): Run => runs.find((r) => r.goal.id === id) as Run

  it('AC-1: deps keep only blockers inside the goal', async () => {
    await svc.createTask({ id: 'TASK-99', projectId: 'p', title: 'Outside, still open' })
    await svc.createTask({ id: 'TASK-10', projectId: 'p', title: 'Goal', status: 'READY' })
    await svc.createTask({ id: 'TASK-11', projectId: 'p', parentTaskId: 'TASK-10', title: 'First' })
    await svc.createTask({ id: 'TASK-12', projectId: 'p', parentTaskId: 'TASK-10', title: 'Second', blockedBy: ['TASK-11'] })
    await svc.createTask({ id: 'TASK-13', projectId: 'p', parentTaskId: 'TASK-10', title: 'Third', blockedBy: ['TASK-99', 'TASK-11'] })
    await notice('[loop:web] ⚪ run TASK-10 started: 3 tasks')
    const [run] = await runsOf()
    expect(run.items.map((i) => [i.id, i.deps])).toEqual([
      ['TASK-11', []],
      ['TASK-12', ['TASK-11']],
      ['TASK-13', ['TASK-11']]
    ])
  })

  it('AC-2: the run carries its project id and name', async () => {
    await svc.createTask({ id: 'TASK-10', projectId: 'p', title: 'Goal', status: 'READY' })
    await notice('[loop:web] ⚪ run TASK-10 started: 0 tasks')
    const [run] = await runsOf()
    expect(run.project).toEqual({ id: 'p', name: 'P' })
  })

  it('AC-3..AC-6: stage and failedAt follow the six derivation rules', async () => {
    // One goal per rule. Rule 5 needs an IMPLEMENTED item; the others have a TODO one.
    for (const n of [1, 2, 3, 4, 5, 6]) {
      await svc.createTask({ id: `TASK-${n}0`, projectId: 'p', title: `Rule ${n}`, status: 'READY' })
      await svc.createTask({
        id: `TASK-${n}1`,
        projectId: 'p',
        parentTaskId: `TASK-${n}0`,
        title: 'Item',
        status: n === 5 ? 'IMPLEMENTED' : 'TODO'
      })
    }
    await notice('[loop:web] ⚪ run TASK-10 started: 1 tasks')
    await notice('[loop:web] 🟢 run TASK-10 ready: 1 items in 1 PR(s)')
    await notice('[loop:web] ⚪ run TASK-10 finished\nDONE: TASK-11')
    await notice('[loop:web] 🟢 run TASK-20 ready: 1 items in 1 PR(s)')
    await notice('[loop:web] 🔴 run TASK-20: https://github.com/o/r/pull/2 closed without merge — items stay IMPLEMENTED')
    await notice('[loop:web] ⚪ run TASK-30 started: 1 tasks')
    await notice('[loop:web] 🟢 run TASK-30 ready: 1 items in 1 PR(s)')
    await notice('[loop:web] 🔴 run TASK-40 refused: dirty tree in C:\\x')
    await notice('[loop:web] ⚪ run TASK-50 started: 1 tasks')
    await notice('[loop:web] ⚪ run TASK-60 started: 1 tasks')

    const runs = await runsOf()
    const at = (n: number): Run => byGoal(runs, `TASK-${n}0`)
    expect([1, 2, 3, 4, 5, 6].map((n) => at(n).stage)).toEqual(['done', 'merged', 'pr-opened', 'started', 'working', 'started'])
    expect(at(2).failedAt).toBe('merged')
    expect(at(4).failedAt).toBe('started')
    expect([1, 3, 5, 6].map((n) => at(n).failedAt)).toEqual([null, null, null, null])
  })

  it('AC-7: prUrls are distinct and in first-seen order across notices', async () => {
    await svc.createTask({ id: 'TASK-10', projectId: 'p', title: 'Goal', status: 'READY' })
    await notice(
      '[loop:web] 🟢 run TASK-10 ready: 2 items in 1 PR(s)\nhttps://github.com/butterngo/x/pull/7\nagain https://github.com/butterngo/x/pull/7'
    )
    await notice('[loop:web] ⚪ run TASK-10 finished\nmerged https://github.com/butterngo/y/pull/2')
    const [run] = await runsOf()
    expect(run.prUrls).toEqual(['https://github.com/butterngo/x/pull/7', 'https://github.com/butterngo/y/pull/2'])
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
    activeSince,
    deps: []
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

// TASK-2857 — Run.waiting: a run whose Claude Code session waits on Butter.
describe('Run.waiting', () => {
  const S = '2026-10-28T09:05:00.000Z'
  const att = (state: 'waiting' | 'finished', cwd: string): AttentionSession => ({
    sessionId: 'cc-1',
    cwd,
    workspaceId: 'web',
    state,
    since: S
  })

  async function goal(): Promise<void> {
    await svc.createTask({ id: 'TASK-1', projectId: 'p', title: 'Goal', status: 'IN-PROGRESS' })
    await svc.createTask({ id: 'TASK-2', projectId: 'p', parentTaskId: 'TASK-1', title: 'Item', body: BODY })
    await notice(String.raw`[loop:web] ⚪ run TASK-1 started in C:\dev\x.worktrees\autopilot-TASK-1`)
  }

  const run1 = (runs: Run[]): Run | undefined => runs.find((r) => r.goal.id === 'TASK-1')

  it('AC-1 a waiting attention file inside autopilot-TASK-1 marks that run waiting', async () => {
    await goal()
    const { runs } = await buildRuns(svc, [att('waiting', String.raw`C:\dev\x.worktrees\autopilot-TASK-1`)])
    expect(run1(runs)?.waiting).toEqual({ sessionId: 'cc-1', since: S })
  })

  it('AC-2 the same file with state finished → waiting null', async () => {
    await goal()
    const { runs } = await buildRuns(svc, [att('finished', String.raw`C:\dev\x.worktrees\autopilot-TASK-1`)])
    expect(run1(runs)?.waiting).toBeNull()
  })

  it('AC-3 a waiting file in autopilot-TASK-10 does not mark the run for TASK-1', async () => {
    await goal()
    const { runs } = await buildRuns(svc, [att('waiting', String.raw`C:\dev\x.worktrees\autopilot-TASK-10`)])
    expect(run1(runs)?.waiting).toBeNull()
  })

  it('AC-4 a run with no attention file → waiting null', async () => {
    await goal()
    const { runs } = await buildRuns(svc)
    expect(run1(runs)?.waiting).toBeNull()
  })

  it('AC-5 every other run field equals the response built without the attention join', async () => {
    await goal()
    const strip = (r: Run | undefined): Omit<Run, 'waiting'> | undefined => {
      if (!r) return r
      const { waiting: _w, ...rest } = r
      return rest
    }
    const without = await buildRuns(svc)
    const withJoin = await buildRuns(svc, [att('waiting', String.raw`C:\dev\x.worktrees\autopilot-TASK-1`)])
    expect(strip(run1(withJoin.runs))).toEqual(strip(run1(without.runs)))
    expect(withJoin.otherNotices).toEqual(without.otherNotices)
  })

  it('GET /runs passes the attention source through', async () => {
    await goal()
    const s = createServer((req, res) => {
      void handleRunsRoute(req, res, {
        svc,
        bridgeToken: TOKEN,
        attention: async () => [att('waiting', 'C:/dev/x.worktrees/autopilot-TASK-1/sub')]
      })
    })
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
    const r = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/runs`, {
      headers: { 'x-choda-bridge-token': TOKEN }
    })
    const body = (await r.json()) as { runs: Run[] }
    await new Promise<void>((r2) => s.close(() => r2()))
    expect(run1(body.runs)?.waiting).toEqual({ sessionId: 'cc-1', since: S })
  })
})
