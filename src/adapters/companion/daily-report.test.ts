import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import Database from 'better-sqlite3'
import { SqliteTaskService } from '../../core/domain/sqlite-task-service'
import { focusBoard } from '../../core/domain/daily/focus'
import type { RepoScan, ScanWorkspaceInput } from '../../core/domain/daily/workspace-scan'
import { createScanCache } from '../../core/domain/daily/scan-cache'
import { handleDailyReportRoute, type DailyReport } from './daily-report'

// TASK-2673 — GET /daily-report over real HTTP and a real SQLite service, with
// the git scan injected.

// 2026-10-24 03:00 +07 — still the 2026-10-23 day (05:00 boundary).
const NOW = Date.parse('2026-10-23T20:00:00Z')

let tmp: string
let dbPath: string
let svc: SqliteTaskService
let server: Server
let base: string
let scanResult: (ws: ScanWorkspaceInput[]) => RepoScan[]

const okRepo = (ws: ScanWorkspaceInput, extra: Partial<RepoScan> = {}): RepoScan => ({
  toplevel: ws.cwd,
  workspaceIds: [ws.id],
  projectIds: [ws.projectId],
  state: 'ok',
  defaultBranch: 'main',
  dirtyFiles: 0,
  unmergedBranches: [],
  prs: 'ok',
  openPrs: [],
  ...extra
})

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-'))
  dbPath = path.join(tmp, 'test.db')
  svc = new SqliteTaskService(dbPath)
  await svc.ensureProject('p', 'P', tmp)
  await svc.ensureProject('q', 'Q', tmp)
  scanResult = (ws) => ws.map((w) => okRepo(w))
  server = createServer((req, res) => {
    handleDailyReportRoute(req, res, {
      svc,
      now: () => NOW,
      scan: async (ws) => scanResult(ws)
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
  await svc.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const get = async (query = ''): Promise<{ status: number; body: unknown }> => {
  const res = await fetch(`${base}/daily-report${query}`)
  return { status: res.status, body: await res.json() }
}
const report = async (query = ''): Promise<DailyReport> => (await get(query)).body as DailyReport

/** Two projects with one of each outstanding kind, plus inbox in p, q and no project. */
async function seed(): Promise<void> {
  await svc.createTask({
    id: 'TASK-1',
    projectId: 'p',
    title: 'implemented',
    status: 'IMPLEMENTED'
  })
  await svc.createTask({
    id: 'TASK-2',
    projectId: 'p',
    title: 'wip, no session',
    status: 'IN-PROGRESS'
  })
  await svc.createTask({ id: 'TASK-3', projectId: 'p', title: 'stale session', status: 'READY' })
  await svc.createTask({
    id: 'TASK-4',
    projectId: 'p',
    title: 'overdue',
    status: 'TODO',
    dueDate: '2026-10-01'
  })
  await svc.createTask({
    id: 'TASK-5',
    projectId: 'p',
    title: 'done, past due',
    status: 'DONE',
    dueDate: '2026-10-01'
  })
  await svc.createTask({
    id: 'TASK-6',
    projectId: 'q',
    title: 'implemented q',
    status: 'IMPLEMENTED'
  })
  const { session } = await svc.startSession({ projectId: 'p', taskId: 'TASK-3' })
  await svc.createInbox({ projectId: 'p', content: 'idea p' })
  await svc.createInbox({ projectId: 'q', content: 'idea q1' })
  await svc.createInbox({ projectId: 'q', content: 'idea q2' })
  const global = await svc.createInbox({ projectId: 'p', content: 'idea global' })
  const raw = new Database(dbPath)
  raw
    .prepare('UPDATE sessions SET started_at = ? WHERE id = ?')
    .run('2026-10-01T00:00:00.000Z', session.id)
  raw.prepare('UPDATE inbox_items SET project_id = NULL WHERE id = ?').run(global.id)
  raw.close()
}

describe('GET /daily-report', () => {
  it('AC-1: every outstanding total equals the sum of that key over the projects', async () => {
    await seed()
    const r = await report()
    for (const [key, total] of Object.entries(r.outstanding.totals)) {
      const sum = r.outstanding.projects.reduce(
        (n, p) => n + p.counts[key as keyof typeof p.counts],
        0
      )
      expect(sum, key).toBe(total)
    }
    expect(r.outstanding.totals.implementedNotDone).toBeGreaterThan(0)
  })

  it('AC-1b: implementedNotDone, inProgressNoSession, staleSessions, overdue and rawInbox equal direct SQL counts', async () => {
    await seed()
    const r = await report()
    const raw = new Database(dbPath, { readonly: true })
    const n = (sql: string, ...args: unknown[]): number =>
      (raw.prepare(sql).get(...args) as { n: number }).n
    const cutoff = new Date(NOW - 3 * 24 * 60 * 60 * 1000).toISOString()
    const expected = {
      implementedNotDone: n("SELECT COUNT(*) n FROM tasks WHERE status = 'IMPLEMENTED'"),
      inProgressNoSession: n(
        "SELECT COUNT(*) n FROM tasks t WHERE status = 'IN-PROGRESS' AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.task_id = t.id AND s.status = 'active')"
      ),
      staleSessions: n(
        "SELECT COUNT(*) n FROM sessions WHERE status = 'active' AND started_at < ?",
        cutoff
      ),
      overdue: n(
        "SELECT COUNT(*) n FROM tasks WHERE due_date < ? AND status NOT IN ('DONE','CANCELLED')",
        '2026-10-23'
      ),
      rawInbox: n("SELECT COUNT(*) n FROM inbox_items WHERE status = 'raw'")
    }
    raw.close()
    expect(expected).toEqual({
      implementedNotDone: 2,
      inProgressNoSession: 1,
      staleSessions: 1,
      overdue: 1,
      rawInbox: 4
    })
    const t = r.outstanding.totals
    expect({
      implementedNotDone: t.implementedNotDone,
      inProgressNoSession: t.inProgressNoSession,
      staleSessions: t.staleSessions,
      overdue: t.overdue,
      rawInbox: t.rawInbox
    }).toEqual(expected)
  })

  it('AC-2: yesterday lists both projects; 04:59 +07 on date is yesterday, 05:01 is not', async () => {
    await svc.createTask({ id: 'TASK-1', projectId: 'p', title: 'a', status: 'READY' })
    await svc.createTask({ id: 'TASK-2', projectId: 'q', title: 'b', status: 'READY' })
    const sp = await svc.startSession({ projectId: 'p', taskId: 'TASK-1' })
    await svc.endSession(sp.session.id, { handoff: { resumePoint: 'p done' } })
    const sq = await svc.startSession({ projectId: 'q', taskId: 'TASK-2' })
    await svc.endSession(sq.session.id, { handoff: { resumePoint: 'q done' } })
    const raw = new Database(dbPath)
    raw.exec('DELETE FROM task_status_changes')
    const ins = raw.prepare(
      'INSERT INTO task_status_changes (task_id, from_status, to_status, at) VALUES (?, ?, ?, ?)'
    )
    ins.run('TASK-1', 'IN-PROGRESS', 'DONE', '2026-10-22T21:59:00.000Z') // 04:59 +07 on 2026-10-23
    ins.run('TASK-2', 'IN-PROGRESS', 'DONE', '2026-10-22T22:01:00.000Z') // 05:01 +07 on 2026-10-23
    ins.run('TASK-2', 'READY', 'IN-PROGRESS', '2026-10-22T03:00:00.000Z') // 10:00 +07 on 2026-10-22
    raw
      .prepare('UPDATE sessions SET ended_at = ? WHERE id = ?')
      .run('2026-10-22T10:00:00.000Z', sp.session.id)
    raw
      .prepare('UPDATE sessions SET ended_at = ? WHERE id = ?')
      .run('2026-10-22T11:00:00.000Z', sq.session.id)
    raw.close()

    const y = (await report('?date=2026-10-23')).yesterday
    expect(y.date).toBe('2026-10-22')
    expect(y.statusChanges.map((c) => `${c.taskId}:${c.to}`)).toEqual([
      'TASK-2:IN-PROGRESS',
      'TASK-1:DONE'
    ])
    expect(new Set(y.statusChanges.map((c) => c.projectId))).toEqual(new Set(['p', 'q']))
    expect(y.sessionsEnded.map((s) => s.projectId)).toEqual(['p', 'q'])
    expect(y.sessionsEnded.map((s) => s.resumePoint)).toEqual(['p done', 'q done'])
  })

  it('AC-3: an invalid date answers 400 naming it', async () => {
    const res = await get('?date=2026-13-40')
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'invalid date: 2026-13-40' })
  })

  it('AC-4: a failed repo is listed in coverage, counted unscanned and never dirty', async () => {
    await svc.addWorkspace('p', 'w1', 'W1', path.join(tmp, 'w1'))
    await svc.addWorkspace('p', 'w2', 'W2', path.join(tmp, 'w2'))
    scanResult = (ws) =>
      ws.map((w) =>
        w.id === 'w1'
          ? {
              ...okRepo(w),
              toplevel: null,
              state: 'failed',
              reason: 'boom',
              dirtyFiles: null,
              unmergedBranches: null,
              prs: 'unknown'
            }
          : okRepo(w)
      )
    const r = await report()
    expect(r.coverage.workspaces.find((c) => c.id === 'w1')).toMatchObject({
      state: 'failed',
      reason: 'boom'
    })
    const p = r.outstanding.projects.find((x) => x.projectId === 'p')!
    expect(p.counts.unscannedWorkspaces).toBe(1)
    expect(p.counts.dirtyWorkspaces).toBe(0)
    expect(r.coverage.scanned).toBe(1)
    expect(r.coverage.total).toBe(2)
  })

  it('AC-5: within each project, outstanding items are ordered by at ascending', async () => {
    await seed()
    const raw = new Database(dbPath)
    raw
      .prepare("UPDATE tasks SET updated_at = '2026-09-01T00:00:00.000Z' WHERE id = 'TASK-2'")
      .run()
    raw
      .prepare("UPDATE tasks SET updated_at = '2026-10-20T00:00:00.000Z' WHERE id = 'TASK-1'")
      .run()
    raw.close()
    const r = await report()
    for (const p of r.outstanding.projects) {
      const ats = p.items.map((i) => i.at).filter((a): a is string => a !== null)
      expect(ats, String(p.projectId)).toEqual([...ats].sort())
    }
    const pItems = r.outstanding.projects.find((x) => x.projectId === 'p')!.items.map((i) => i.id)
    expect(pItems.indexOf('TASK-2')).toBeLessThan(pItems.indexOf('TASK-1'))
  })

  it('AC-6: raw inbox is counted and dated but never listed as an item', async () => {
    await seed()
    const r = await report()
    const all = r.outstanding.projects.flatMap((p) => p.items)
    expect(all.some((i) => i.id.startsWith('INBOX-'))).toBe(false)
    const global = r.outstanding.projects.find((p) => p.projectId === null)!
    expect(global.counts.rawInbox).toBe(1)
    expect(global.items).toEqual([])
    expect(global.oldestAt).not.toBeNull()
  })

  it('AC-7: with no date at 2026-10-24 03:00 +07, date is 2026-10-23 and yesterday 2026-10-22', async () => {
    const r = await report()
    expect(r.date).toBe('2026-10-23')
    expect(r.yesterday.date).toBe('2026-10-22')
  })

  it('AC-8: today.focus has one entry per project and equals focus_board on the same DB', async () => {
    await seed()
    const r = await report()
    const projects = (await svc.listProjects()).map((p) => p.id).sort()
    expect(r.today.focus.map((f) => f.projectId).sort()).toEqual(projects)
    expect(r.today.focus).toEqual(JSON.parse(JSON.stringify(await focusBoard(svc, NOW))))
  })
})

// TASK-2704 — the git half served from a scan cache: a counting scan stub and a
// clock the test moves.
describe('GET /daily-report with a scan cache', () => {
  let clock: number
  let scanCalls: number
  let gate: Promise<void> | null
  let cachedServer: Server
  let cachedBase: string

  beforeEach(async () => {
    clock = NOW
    scanCalls = 0
    gate = null
    const scanCache = createScanCache({
      now: () => clock,
      scan: async (ws) => {
        scanCalls++
        if (gate) await gate
        return scanResult(ws)
      }
    })
    cachedServer = createServer((req, res) => {
      void handleDailyReportRoute(req, res, { svc, now: () => clock, scanCache })
    })
    await new Promise<void>((r) => cachedServer.listen(0, '127.0.0.1', () => r()))
    cachedBase = `http://127.0.0.1:${(cachedServer.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise<void>((r) => cachedServer.close(() => r()))
  })

  const cached = async (query = ''): Promise<DailyReport> =>
    (await (await fetch(`${cachedBase}/daily-report${query}`)).json()) as DailyReport
  const iso = (ms: number): string => new Date(ms).toISOString()
  const MIN = 60 * 1000

  it('AC-1: two calls 1 minute apart run the scan once and share scannedAt', async () => {
    const first = await cached()
    clock += MIN
    const second = await cached()
    expect(scanCalls).toBe(1)
    expect(first.coverage.scannedAt).toBe(iso(NOW))
    expect(second.coverage.scannedAt).toBe(first.coverage.scannedAt)
  })

  it('AC-2: ?fresh=1 scans even when the cache is 1 minute old', async () => {
    await cached()
    clock += MIN
    const r = await cached('?fresh=1')
    expect(scanCalls).toBe(2)
    expect(r.coverage.scannedAt).toBe(iso(NOW + MIN))
  })

  it('AC-3: a 6-minute-old cache answers at once, rescans once in the background, and the next call is new', async () => {
    await cached()
    clock += 6 * MIN
    let release!: () => void
    gate = new Promise<void>((r) => (release = r))
    const stale = await cached()
    expect(stale.coverage.scannedAt).toBe(iso(NOW))
    expect(scanCalls).toBe(2)
    const again = await cached()
    expect(again.coverage.scannedAt).toBe(iso(NOW))
    expect(scanCalls).toBe(2)
    release()
    await new Promise((r) => setTimeout(r, 20))
    const next = await cached()
    expect(next.coverage.scannedAt).toBe(iso(NOW + 6 * MIN))
    expect(scanCalls).toBe(2)
  })

  it('AC-4: five concurrent calls on an empty cache start exactly one scan', async () => {
    let release!: () => void
    gate = new Promise<void>((r) => (release = r))
    const pending = Promise.all(Array.from({ length: 5 }, () => cached()))
    await new Promise((r) => setTimeout(r, 50))
    release()
    const all = await pending
    expect(scanCalls).toBe(1)
    expect(new Set(all.map((r) => r.coverage.scannedAt))).toEqual(new Set([iso(NOW)]))
  })

  it('AC-5: a repo cached as failed/timeout stays unscanned on a cached call, never dirty', async () => {
    await svc.addWorkspace('p', 'w1', 'W1', path.join(tmp, 'w1'))
    scanResult = (ws) =>
      ws.map((w) => ({
        ...okRepo(w),
        toplevel: null,
        state: 'failed',
        reason: 'timeout',
        dirtyFiles: null,
        unmergedBranches: null,
        prs: 'unknown'
      }))
    await cached()
    clock += MIN
    const r = await cached()
    expect(scanCalls).toBe(1)
    expect(r.coverage.workspaces.find((c) => c.id === 'w1')).toMatchObject({
      state: 'failed',
      reason: 'timeout'
    })
    const p = r.outstanding.projects.find((x) => x.projectId === 'p')!
    expect(p.counts.unscannedWorkspaces).toBe(1)
    expect(p.counts.dirtyWorkspaces).toBe(0)
  })

  it('AC-6: a task status change between two cached calls shows in the second call', async () => {
    await svc.createTask({ id: 'TASK-9', projectId: 'p', title: 'moving', status: 'IN-PROGRESS' })
    const before = await cached()
    await svc.updateTask('TASK-9', { status: 'IMPLEMENTED' })
    clock += MIN
    const after = await cached()
    expect(scanCalls).toBe(1)
    const ids = (r: DailyReport): string[] =>
      (r.outstanding.projects.find((x) => x.projectId === 'p')?.items ?? [])
        .filter((i) => i.kind === 'implemented-not-done')
        .map((i) => i.id)
    expect(ids(before)).not.toContain('TASK-9')
    expect(ids(after)).toContain('TASK-9')
  })
})
