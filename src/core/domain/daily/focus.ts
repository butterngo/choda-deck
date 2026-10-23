import type { Session, Task, TaskPriority } from '../task-types'
import type { TaskOperations } from '../interfaces/task-repository.interface'
import type { SessionOperations } from '../interfaces/session-repository.interface'
import type { ProjectOperations } from '../interfaces/project-repository.interface'
import type { WorkspaceOperations } from '../interfaces/workspace-repository.interface'
import { planDate } from './plan-date'

// TASK-2686 — the /choda-task-focus tiers in code, so the companion's Today
// screen (TASK-2669) can show every project's focus at once and the skill can
// later call the same definition instead of re-deriving it in prose (TASK-2678).
//
// Ported from ~/.claude/skills/choda-task-focus/SKILL.md §2 (tiers), §3 (resume),
// §5.4 (blocked) and §5.7 (awaiting close). Resolved per PROJECT, not per
// workspace: tasks carry no workspaceId and touches-based scoping resolves almost
// nothing (INBOX-1986), so the workspace is reported only when a session names it.
//
// Tier order, first hit wins (skill §2 note — overdue outranks READY):
//   session → in-progress → pinned → overdue → ready → due-soon → cold

export type FocusTier =
  | 'session'
  | 'in-progress'
  | 'pinned'
  | 'overdue'
  | 'ready'
  | 'due-soon'
  | 'cold'

export interface FocusTask {
  id: string
  title: string
  status: Task['status']
  priority: TaskPriority | null
  dueDate: string | null
  /** Blockers that are not IMPLEMENTED, DONE or CANCELLED. */
  blockedBy: string[]
}

export interface FocusEntry {
  projectId: string
  tier: FocusTier
  focus: FocusTask | null
  also: { id: string; title: string; priority: TaskPriority | null }[]
  awaitingClose: { id: string; title: string }[]
  resume: { sessionId: string; resumePoint: string; looseEnds: string[] } | null
  workspace: { id: string; cwd: string } | null
}

export type FocusDeps = Pick<TaskOperations, 'findTasks' | 'getTask'> &
  Pick<SessionOperations, 'findSessions'> &
  Pick<ProjectOperations, 'listProjects'> &
  Pick<WorkspaceOperations, 'findWorkspaces'>

/** Due within this many days of the plan date counts as due-soon (skill tier 5b). */
export const DUE_SOON_DAYS = 3

const SATISFIED = new Set<Task['status']>(['IMPLEMENTED', 'DONE', 'CANCELLED'])
const OPEN = new Set<Task['status']>(['TODO', 'READY', 'IN-PROGRESS'])
const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }

function byPriorityThenId(a: Task, b: Task): number {
  const pa = a.priority ? PRIORITY_RANK[a.priority] : 4
  const pb = b.priority ? PRIORITY_RANK[b.priority] : 4
  if (pa !== pb) return pa - pb
  return a.id.localeCompare(b.id, 'en', { numeric: true })
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** The focus of one project at `nowMs`. */
export async function resolveFocus(
  deps: FocusDeps,
  projectId: string,
  nowMs: number = Date.now()
): Promise<FocusEntry> {
  const today = planDate(nowMs)
  const tasks = await deps.findTasks({ projectId })
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const sessions = await deps.findSessions(projectId)

  // Blockers may sit in another project, so look up whatever this project does not hold.
  const statusOf = async (id: string): Promise<Task['status'] | null> =>
    byId.get(id)?.status ?? (await deps.getTask(id))?.status ?? null
  const openBlockers = async (t: Task): Promise<string[]> => {
    const out: string[] = []
    for (const b of t.blockedBy) {
      const s = await statusOf(b)
      if (s === null || !SATISFIED.has(s)) out.push(b)
    }
    return out
  }

  const childrenOf = new Map<string, Task[]>()
  for (const t of tasks) {
    if (!t.parentTaskId) continue
    const list = childrenOf.get(t.parentTaskId) ?? []
    list.push(t)
    childrenOf.set(t.parentTaskId, list)
  }
  const isAwaitingClose = (t: Task): boolean => {
    const kids = childrenOf.get(t.id) ?? []
    return (
      (t.status === 'TODO' || t.status === 'READY') &&
      kids.length > 0 &&
      kids.every((k) => SATISFIED.has(k.status))
    )
  }
  const awaitingClose = tasks
    .filter(isAwaitingClose)
    .sort(byPriorityThenId)
    .map((t) => ({ id: t.id, title: t.title }))

  const open = tasks.filter((t) => OPEN.has(t.status))
  const unblocked = async (list: Task[]): Promise<Task[]> => {
    const out: Task[] = []
    for (const t of list) if ((await openBlockers(t)).length === 0) out.push(t)
    return out
  }

  // Tier 1 — the newest active session bound to a task of this project.
  const active = sessions
    .filter((s) => s.status === 'active' && s.taskId && byId.has(s.taskId))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  const sessionTasks = active.map((s) => byId.get(s.taskId!)!)

  const dueSoonLimit = addDays(today, DUE_SOON_DAYS)
  const candidates: [FocusTier, () => Promise<Task[]>][] = [
    ['session', async () => dedupe(sessionTasks)],
    [
      'in-progress',
      async () => open.filter((t) => t.status === 'IN-PROGRESS').sort(byPriorityThenId)
    ],
    ['pinned', async () => open.filter((t) => t.pinned).sort(byPriorityThenId)],
    [
      'overdue',
      async () => open.filter((t) => t.dueDate !== null && t.dueDate < today).sort(byPriorityThenId)
    ],
    [
      'ready',
      async () =>
        (await unblocked(open.filter((t) => t.status === 'READY' && !isAwaitingClose(t)))).sort(
          byPriorityThenId
        )
    ],
    [
      'due-soon',
      async () =>
        (
          await unblocked(
            open.filter(
              (t) => t.dueDate !== null && t.dueDate >= today && t.dueDate <= dueSoonLimit
            )
          )
        ).sort(byPriorityThenId)
    ]
  ]

  for (const [tier, pick] of candidates) {
    const hits = await pick()
    if (hits.length === 0) continue
    const [first, ...rest] = hits
    return {
      projectId,
      tier,
      focus: {
        id: first.id,
        title: first.title,
        status: first.status,
        priority: first.priority,
        dueDate: first.dueDate,
        blockedBy: await openBlockers(first)
      },
      also: rest.map((t) => ({ id: t.id, title: t.title, priority: t.priority })),
      awaitingClose,
      resume: resumeOf(sessions, first.id),
      workspace: await workspaceOf(deps, projectId, sessions, first.id)
    }
  }

  return {
    projectId,
    tier: 'cold',
    focus: null,
    also: [],
    awaitingClose,
    resume: null,
    workspace: null
  }
}

/** Every registered project's focus, cold ones included. */
export async function focusBoard(
  deps: FocusDeps,
  nowMs: number = Date.now()
): Promise<FocusEntry[]> {
  const projects = await deps.listProjects()
  const out: FocusEntry[] = []
  for (const p of projects) out.push(await resolveFocus(deps, p.id, nowMs))
  return out
}

function dedupe(list: Task[]): Task[] {
  const seen = new Set<string>()
  return list.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)))
}

/** Skill §3 — the newest session of the focus task that left a resume point. */
function resumeOf(sessions: Session[], taskId: string): FocusEntry['resume'] {
  const withPoint = sessions
    .filter((s) => s.taskId === taskId && (s.handoff?.resumePoint || s.checkpoint?.resumePoint))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]
  if (!withPoint) return null
  return {
    sessionId: withPoint.id,
    resumePoint: (withPoint.handoff?.resumePoint || withPoint.checkpoint?.resumePoint)!,
    looseEnds: withPoint.handoff?.looseEnds ?? []
  }
}

async function workspaceOf(
  deps: FocusDeps,
  projectId: string,
  sessions: Session[],
  taskId: string
): Promise<FocusEntry['workspace']> {
  const newest = sessions
    .filter((s) => s.taskId === taskId && s.workspaceId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]
  if (!newest) return null
  const ws = (await deps.findWorkspaces(projectId)).find((w) => w.id === newest.workspaceId)
  return ws ? { id: ws.id, cwd: ws.cwd } : null
}
