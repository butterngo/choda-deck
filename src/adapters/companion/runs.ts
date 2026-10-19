import type { IncomingMessage, ServerResponse } from 'http'
import { Buffer } from 'buffer'
import { timingSafeEqual } from 'crypto'
import type { InboxItem, Session, Task } from '../../core/domain/task-types'
import type { InboxOperations } from '../../core/domain/interfaces/inbox-repository.interface'
import type { SessionOperations } from '../../core/domain/interfaces/session-repository.interface'
import type { TaskOperations } from '../../core/domain/interfaces/task-repository.interface'

// TASK-2531 — one record per loop run, for the companion's Runs screen
// (TASK-2532). Butter, 2026-10-19: "làm sao để biết được xong task nào, đã test
// những gì, còn gì". Everything a /choda-autopilot or /choda-burn-backlog run
// produces is already stored, just in five places: the [loop:<ws>] notices, the
// goal's subtasks, their acceptance checkboxes, each item's session handoff and
// its commits. The decide screen shows only the notices, and a dismissed notice
// is gone, so this joins them per run and keeps archived notices in.
//
// A run's state reads sessions before notices. On 2026-10-19 TASK-2513's newest
// notice said 🔴 halted while TASK-2517 had been working for an hour: the notice
// is a report of a moment, an active session is the present.

export type RunState = 'running' | 'finished' | 'halted' | 'waiting-merge' | 'idle'
export type NoticeKind = 'started' | 'finished' | 'blocked' | 'decision' | 'ready' | 'other'

export interface RunNotice {
  id: string
  workspaceId: string | null
  kind: NoticeKind
  /** First line, `[loop:<ws>]` removed. */
  title: string
  content: string
  createdAt: string
  /** raw = still on the decide screen; archived = dismissed there. */
  status: string
}

export interface RunItem {
  id: string
  title: string
  status: string
  ac: { ticked: number; total: number; humanOpen: string[] }
  /** "<sha> <subject>" as the newest handoff stored it, or null. */
  commit: string | null
  tests: { passed: string[]; skipped: string[] } | null
  /** startedAt of an active session on this item, or null. */
  activeSince: string | null
}

export interface Run {
  goal: { id: string; title: string; status: string; projectId: string }
  state: RunState
  items: RunItem[]
  notices: RunNotice[]
  lastActivityAt: string
}

export interface RunsDeps {
  svc: Pick<InboxOperations, 'findInbox'> &
    Pick<TaskOperations, 'getTask' | 'getSubtasks'> &
    Pick<SessionOperations, 'findSessions'>
  bridgeToken: string
}

const LOOP_TAG = /^\[loop:([A-Za-z0-9._-]+)\]\s*/
const RUN_GOAL = /\brun (TASK-\d+)\b/
const TASK_ID = /\bTASK-\d+\b/g

export function noticeKind(text: string): NoticeKind {
  const head = text.trimStart()
  if (head.startsWith('🔴')) return 'blocked'
  if (head.startsWith('🟡')) return 'decision'
  if (head.startsWith('🟢')) return 'ready'
  if (head.startsWith('⚪')) return /\bfinished\b/.test(head) ? 'finished' : 'started'
  return 'other'
}

export function toNotice(item: InboxItem): RunNotice | null {
  const m = LOOP_TAG.exec(item.content)
  if (!m) return null
  const rest = item.content.slice(m[0].length)
  return {
    id: item.id,
    workspaceId: item.workspaceId,
    kind: noticeKind(rest),
    title: rest.split(/\r?\n/)[0]?.trim() ?? '',
    content: item.content,
    createdAt: item.createdAt,
    status: item.status
  }
}

/** The checkboxes under `## Acceptance` only — Test Plan checklists are not criteria. */
export function acceptanceCounts(body: string | null): RunItem['ac'] {
  const section = (body ?? '').split(/^## Acceptance[^\n]*$/m)[1]?.split(/^## /m)[0] ?? ''
  let ticked = 0
  let total = 0
  const humanOpen: string[] = []
  for (const line of section.split(/\r?\n/)) {
    const m = /^\s*- \[( |x|X)\]\s*(.*)$/.exec(line)
    if (!m) continue
    total++
    if (m[1] !== ' ') ticked++
    else if (/\bhuman\b/i.test(m[2])) humanOpen.push(m[2].trim())
  }
  return { ticked, total, humanOpen }
}

export function runState(items: RunItem[], notices: RunNotice[]): RunState {
  if (items.some((i) => i.activeSince)) return 'running'
  const newest = [...notices].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  switch (newest?.kind) {
    case 'finished':
      return 'finished'
    case 'blocked':
      return 'halted'
    case 'ready':
      return 'waiting-merge'
    default:
      return 'idle'
  }
}

function toItem(task: Task, sessions: Session[]): RunItem {
  const mine = sessions
    .filter((s) => s.taskId === task.id)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  const active = mine.find((s) => s.status === 'active') ?? null
  const withHandoff = mine.find((s) => s.handoff)
  const handoff = withHandoff?.handoff ?? null
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    ac: acceptanceCounts(task.body),
    commit: handoff?.commits?.[0] ?? null,
    tests: handoff?.testResults
      ? { passed: handoff.testResults.passed ?? [], skipped: handoff.testResults.skipped ?? [] }
      : null,
    activeSince: active?.startedAt ?? null
  }
}

export async function buildRuns(
  svc: RunsDeps['svc']
): Promise<{ runs: Run[]; otherNotices: RunNotice[] }> {
  const [raw, archived] = await Promise.all([
    svc.findInbox({ status: 'raw' }),
    svc.findInbox({ status: 'archived' })
  ])
  const notices = [...raw, ...archived]
    .map(toNotice)
    .filter((n): n is RunNotice => n !== null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  const byGoal = new Map<string, RunNotice[]>()
  const unplaced: RunNotice[] = []
  for (const n of notices) {
    const goal = RUN_GOAL.exec(n.content)?.[1]
    if (goal) byGoal.set(goal, [...(byGoal.get(goal) ?? []), n])
    else unplaced.push(n)
  }

  const sessionsByProject = new Map<string, Session[]>()
  const runs: Run[] = []
  for (const [goalId, goalNotices] of byGoal) {
    const goal = await svc.getTask(goalId)
    if (!goal) {
      unplaced.push(...goalNotices)
      continue
    }
    if (!sessionsByProject.has(goal.projectId)) {
      sessionsByProject.set(goal.projectId, await svc.findSessions(goal.projectId))
    }
    const sessions = sessionsByProject.get(goal.projectId) ?? []
    const subtasks = await svc.getSubtasks(goalId)
    const items = subtasks
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
      .map((t) => toItem(t, sessions))
    runs.push({
      goal: { id: goal.id, title: goal.title, status: goal.status, projectId: goal.projectId },
      state: 'idle',
      items,
      notices: goalNotices,
      lastActivityAt: ''
    })
  }

  // An item-level notice ("🔴 TASK-2515 blocked: …") names an item, not the run.
  const otherNotices: RunNotice[] = []
  for (const n of unplaced) {
    const ids = new Set(n.content.match(TASK_ID) ?? [])
    const run = runs.find((r) => r.items.some((i) => ids.has(i.id)))
    if (run) run.notices.push(n)
    else otherNotices.push(n)
  }

  for (const run of runs) {
    run.notices.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    run.state = runState(run.items, run.notices)
    run.lastActivityAt = [
      ...run.notices.map((n) => n.createdAt),
      ...run.items.map((i) => i.activeSince ?? '')
    ].reduce((a, b) => (b > a ? b : a), '')
  }
  runs.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
  otherNotices.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return { runs, otherNotices }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function tokenMatches(header: string | undefined, expected: string): boolean {
  if (typeof header !== 'string' || header.length === 0) return false
  const provided = Buffer.from(header, 'utf8')
  const expectedBuf = Buffer.from(expected, 'utf8')
  if (provided.length !== expectedBuf.length) return false
  return timingSafeEqual(provided, expectedBuf)
}

/** Returns true when it handled the request. */
export async function handleRunsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RunsDeps
): Promise<boolean> {
  if ((req.url ?? '/').split('?')[0] !== '/runs') return false
  if (!tokenMatches(req.headers['x-choda-bridge-token'] as string | undefined, deps.bridgeToken)) {
    sendJson(res, 401, { error: 'invalid or missing x-choda-bridge-token' })
    return true
  }
  if (req.method !== 'GET') return (sendJson(res, 405, { error: 'GET only' }), true)
  try {
    sendJson(res, 200, await buildRuns(deps.svc))
  } catch (err) {
    sendJson(res, 500, { error: (err as Error).message })
  }
  return true
}
