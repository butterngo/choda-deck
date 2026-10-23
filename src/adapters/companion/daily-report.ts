// TASK-2673 — GET /daily-report: the whole companion Today screen (TASK-2669)
// in one response, computed live on every call — no snapshot.
//
//   GET /daily-report?date=YYYY-MM-DD  (date optional, default planDate(now))
//   200 { date, generatedAt, yesterday, today: { date, focus }, outstanding, coverage }
//   400 { error: "invalid date: <value>" }
//
// Read-only and local, so GET without the bridge token, like /attention.
//
// A day is [date 05:00, date+1 05:00) Asia/Ho_Chi_Minh (planDate, TASK-2670).
// Git state comes from scanWorkspaces (TASK-2671): a repo whose scan is not ok
// is counted in unscannedWorkspaces and never in dirtyWorkspaces, so "nothing
// outstanding" is something the report has proven. Focus per project comes from
// resolveFocus (TASK-2686), the same definition the focus_board tool uses.

import type { IncomingMessage, ServerResponse } from 'http'
import type { InboxItem, Session, Task } from '../../core/domain/task-types'
import type { TaskOperations } from '../../core/domain/interfaces/task-repository.interface'
import type { InboxOperations } from '../../core/domain/interfaces/inbox-repository.interface'
import { planDate } from '../../core/domain/daily/plan-date'
import { focusBoard, type FocusDeps, type FocusEntry } from '../../core/domain/daily/focus'
import {
  scanWorkspaces,
  type RepoScan,
  type RepoScanState,
  type ScanWorkspaceInput
} from '../../core/domain/daily/workspace-scan'
import { STALE_DAYS } from '../../core/domain/activity/session-reconcile'

export const DAILY_REPORT_ROUTE = '/daily-report'

/** Asia/Ho_Chi_Minh has no DST, so the 05:00 boundary is a fixed UTC offset. */
const DAY_START = 'T05:00:00+07:00'

export type DailyReportDeps = {
  svc: FocusDeps & Pick<TaskOperations, 'listStatusChanges'> & Pick<InboxOperations, 'findInbox'>
  /** Defaults to scanWorkspaces with its own timeouts; injected in tests. */
  scan?: (workspaces: ScanWorkspaceInput[]) => Promise<RepoScan[]>
  now?: () => number
}

export interface OutstandingCounts {
  implementedNotDone: number
  inProgressNoSession: number
  staleSessions: number
  overdue: number
  rawInbox: number
  dirtyWorkspaces: number
  unmergedBranches: number
  openPrs: number
  unscannedWorkspaces: number
}

export type OutstandingKind =
  | 'implemented-not-done'
  | 'in-progress-no-session'
  | 'stale-session'
  | 'overdue'
  | 'dirty'
  | 'unmerged'
  | 'open-pr'
  | 'unscanned'

export interface OutstandingItem {
  kind: OutstandingKind
  id: string
  title: string
  /** ISO time or date the item has been waiting since; null for git state, which has none. */
  at: string | null
  workspaceId: string | null
}

export interface OutstandingProject {
  projectId: string | null
  counts: OutstandingCounts
  oldestAt: string | null
  items: OutstandingItem[]
}

export interface DailyReport {
  date: string
  generatedAt: string
  yesterday: {
    date: string
    statusChanges: {
      taskId: string
      projectId: string | null
      title: string | null
      from: string
      to: string
      at: string
    }[]
    sessionsEnded: {
      sessionId: string
      taskId: string | null
      projectId: string
      endedAt: string
      resumePoint: string | null
    }[]
    totals: { toDone: number; toImplemented: number; sessionsEnded: number }
  }
  today: { date: string; focus: FocusEntry[] }
  outstanding: { totals: OutstandingCounts; projects: OutstandingProject[] }
  coverage: {
    total: number
    scanned: number
    workspaces: {
      id: string
      projectId: string
      cwd: string
      state: RepoScanState
      reason: string | null
      prs: 'ok' | 'unknown'
    }[]
  }
}

const COUNT_KEYS: (keyof OutstandingCounts)[] = [
  'implementedNotDone',
  'inProgressNoSession',
  'staleSessions',
  'overdue',
  'rawInbox',
  'dirtyWorkspaces',
  'unmergedBranches',
  'openPrs',
  'unscannedWorkspaces'
]

const zero = (): OutstandingCounts =>
  Object.fromEntries(COUNT_KEYS.map((k) => [k, 0])) as unknown as OutstandingCounts

/** A real calendar date in YYYY-MM-DD, or null. */
export function parseDate(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const d = new Date(`${value}T00:00:00Z`)
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? null : value
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

const dayStartIso = (date: string): string => new Date(`${date}${DAY_START}`).toISOString()

const byAt = (a: OutstandingItem, b: OutstandingItem): number => {
  if (a.at === b.at) return a.id.localeCompare(b.id, 'en', { numeric: true })
  if (a.at === null) return 1
  if (b.at === null) return -1
  return a.at.localeCompare(b.at)
}

export async function buildDailyReport(deps: DailyReportDeps, date: string): Promise<DailyReport> {
  const nowMs = deps.now?.() ?? Date.now()
  const svc = deps.svc
  const yesterday = addDays(date, -1)
  const yFrom = dayStartIso(yesterday)
  const yTo = dayStartIso(date)

  const projects = await svc.listProjects()
  const tasksByProject = new Map<string, Task[]>()
  const sessionsByProject = new Map<string, Session[]>()
  for (const p of projects) {
    tasksByProject.set(p.id, await svc.findTasks({ projectId: p.id }))
    sessionsByProject.set(p.id, await svc.findSessions(p.id))
  }
  const taskById = new Map<string, Task>()
  for (const list of tasksByProject.values()) for (const t of list) taskById.set(t.id, t)

  // ── Yesterday ─────────────────────────────────────────────────────────────
  const statusChanges = (await svc.listStatusChanges(yFrom, yTo)).map((c) => {
    const t = taskById.get(c.taskId)
    return {
      taskId: c.taskId,
      projectId: t?.projectId ?? null,
      title: t?.title ?? null,
      from: c.fromStatus,
      to: c.toStatus,
      at: c.at
    }
  })
  const sessionsEnded: DailyReport['yesterday']['sessionsEnded'] = []
  for (const [projectId, sessions] of sessionsByProject) {
    for (const s of sessions) {
      if (s.endedAt && s.endedAt >= yFrom && s.endedAt < yTo) {
        sessionsEnded.push({
          sessionId: s.id,
          taskId: s.taskId,
          projectId,
          endedAt: s.endedAt,
          resumePoint: s.handoff?.resumePoint ?? null
        })
      }
    }
  }
  sessionsEnded.sort((a, b) => a.endedAt.localeCompare(b.endedAt))

  // ── Outstanding: tasks, sessions, inbox ────────────────────────────────────
  const buckets = new Map<string | null, OutstandingProject>()
  const bucket = (projectId: string | null): OutstandingProject => {
    let b = buckets.get(projectId)
    if (!b) {
      b = { projectId, counts: zero(), oldestAt: null, items: [] }
      buckets.set(projectId, b)
    }
    return b
  }
  const add = (
    projectId: string | null,
    key: keyof OutstandingCounts,
    item: OutstandingItem | null,
    by = 1
  ): void => {
    const b = bucket(projectId)
    b.counts[key] += by
    if (item) b.items.push(item)
  }

  const staleCutoff = new Date(nowMs - STALE_DAYS * 24 * 60 * 60 * 1000).toISOString()
  for (const p of projects) {
    const tasks = tasksByProject.get(p.id) ?? []
    const sessions = sessionsByProject.get(p.id) ?? []
    const activeTaskIds = new Set(
      sessions.filter((s) => s.status === 'active' && s.taskId).map((s) => s.taskId!)
    )
    for (const t of tasks) {
      if (t.status === 'IMPLEMENTED') {
        add(p.id, 'implementedNotDone', {
          kind: 'implemented-not-done',
          id: t.id,
          title: t.title,
          at: t.updatedAt,
          workspaceId: null
        })
      }
      if (t.status === 'IN-PROGRESS' && !activeTaskIds.has(t.id)) {
        add(p.id, 'inProgressNoSession', {
          kind: 'in-progress-no-session',
          id: t.id,
          title: t.title,
          at: t.updatedAt,
          workspaceId: null
        })
      }
      if (t.dueDate && t.dueDate < date && t.status !== 'DONE' && t.status !== 'CANCELLED') {
        add(p.id, 'overdue', {
          kind: 'overdue',
          id: t.id,
          title: t.title,
          at: t.dueDate,
          workspaceId: null
        })
      }
    }
    for (const s of sessions) {
      if (s.status === 'active' && s.startedAt < staleCutoff) {
        const t = s.taskId ? taskById.get(s.taskId) : undefined
        add(p.id, 'staleSessions', {
          kind: 'stale-session',
          id: s.taskId ?? s.id,
          title: t?.title ?? `session ${s.id}`,
          at: s.startedAt,
          workspaceId: s.workspaceId
        })
      }
    }
  }

  const inboxOldest = new Map<string | null, string>()
  const countInbox = (projectId: string | null, items: InboxItem[]): void => {
    if (items.length === 0) return
    add(projectId, 'rawInbox', null, items.length)
    inboxOldest.set(projectId, items.map((i) => i.createdAt).sort()[0])
  }
  for (const p of projects)
    countInbox(p.id, await svc.findInbox({ projectId: p.id, status: 'raw' }))
  countInbox(null, await svc.findInbox({ projectId: null, status: 'raw' }))

  // ── Outstanding: git, and coverage ─────────────────────────────────────────
  const workspaces: (ScanWorkspaceInput & { id: string })[] = []
  for (const p of projects) {
    for (const w of await svc.findWorkspaces(p.id))
      workspaces.push({ id: w.id, projectId: p.id, cwd: w.cwd })
  }
  const scans = await (deps.scan ?? ((ws) => scanWorkspaces(ws)))(workspaces)
  const wsById = new Map(workspaces.map((w) => [w.id, w]))
  const coverage: DailyReport['coverage']['workspaces'] = []

  for (const r of scans) {
    for (const wsId of r.workspaceIds) {
      const w = wsById.get(wsId)
      if (w)
        coverage.push({
          id: w.id,
          projectId: w.projectId,
          cwd: w.cwd,
          state: r.state,
          reason: r.reason ?? null,
          prs: r.prs
        })
    }
    const label = r.toplevel ?? r.workspaceIds.map((id) => wsById.get(id)?.cwd ?? id).join(', ')
    const wsId = r.workspaceIds[0] ?? null
    for (const projectId of r.projectIds) {
      if (r.state !== 'ok') {
        const mine = r.workspaceIds.filter((id) => wsById.get(id)?.projectId === projectId)
        add(
          projectId,
          'unscannedWorkspaces',
          {
            kind: 'unscanned',
            id: mine.join(', '),
            title: `${r.state}${r.reason ? `: ${r.reason}` : ''} — ${label}`,
            at: null,
            workspaceId: mine[0] ?? null
          },
          mine.length
        )
        continue
      }
      if ((r.dirtyFiles ?? 0) > 0) {
        add(projectId, 'dirtyWorkspaces', {
          kind: 'dirty',
          id: wsId ?? label,
          title: `${r.dirtyFiles} uncommitted files in ${label}`,
          at: null,
          workspaceId: wsId
        })
      }
      for (const branch of r.unmergedBranches ?? []) {
        add(projectId, 'unmergedBranches', {
          kind: 'unmerged',
          id: branch,
          title: `${branch} not merged into ${r.defaultBranch} in ${label}`,
          at: null,
          workspaceId: wsId
        })
      }
      for (const pr of r.openPrs) {
        add(projectId, 'openPrs', {
          kind: 'open-pr',
          id: `#${pr.number}`,
          title: `${pr.title} — ${pr.url}`,
          at: null,
          workspaceId: wsId
        })
      }
    }
  }

  const outstandingProjects = [...buckets.values()]
    .filter((b) => COUNT_KEYS.some((k) => b.counts[k] > 0))
    .map((b) => {
      b.items.sort(byAt)
      const times = b.items.map((i) => i.at).filter((a): a is string => a !== null)
      const inbox = inboxOldest.get(b.projectId)
      if (inbox) times.push(inbox)
      b.oldestAt = times.length ? times.sort()[0] : null
      return b
    })
  const totals = zero()
  for (const b of outstandingProjects) for (const k of COUNT_KEYS) totals[k] += b.counts[k]

  return {
    date,
    generatedAt: new Date(nowMs).toISOString(),
    yesterday: {
      date: yesterday,
      statusChanges,
      sessionsEnded,
      totals: {
        toDone: statusChanges.filter((c) => c.to === 'DONE').length,
        toImplemented: statusChanges.filter((c) => c.to === 'IMPLEMENTED').length,
        sessionsEnded: sessionsEnded.length
      }
    },
    today: { date, focus: await focusBoard(svc, nowMs) },
    outstanding: { totals, projects: outstandingProjects },
    coverage: {
      total: workspaces.length,
      scanned: coverage.filter((c) => c.state === 'ok').length,
      workspaces: coverage
    }
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** Returns true when it handled the request. */
export async function handleDailyReportRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DailyReportDeps
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname !== DAILY_REPORT_ROUTE || req.method !== 'GET') return false
  const raw = url.searchParams.get('date')
  let date: string
  if (raw === null) {
    date = planDate(deps.now?.() ?? Date.now())
  } else {
    const parsed = parseDate(raw)
    if (!parsed) {
      sendJson(res, 400, { error: `invalid date: ${raw}` })
      return true
    }
    date = parsed
  }
  sendJson(res, 200, await buildDailyReport(deps, date))
  return true
}
