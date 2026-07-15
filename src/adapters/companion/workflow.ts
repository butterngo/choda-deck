// TASK-1171 — pillar-2 workflow endpoints. Read feed (focus + sessions) and the
// ONLY mutating task/session routes on the companion surface (mark READY,
// start/end session). Reads and writes both go through the writable
// BackendTaskService (`services.svc`) — the readonly `services.db` handle stays
// reserved for the raw sync-column scans (ledger/health/log). Zero MCP edits:
// plain HTTP over core services, same isolation contract as TASK-1158.

import type { IncomingMessage, ServerResponse } from 'http'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'
import type { Session, Task } from '../../core/domain/task-types'

const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }

function byPriority(a: Task, b: Task): number {
  return (
    (PRIORITY_ORDER[a.priority ?? 'low'] ?? 4) - (PRIORITY_ORDER[b.priority ?? 'low'] ?? 4) ||
    a.id.localeCompare(b.id)
  )
}

export interface FocusFeed {
  workspaceId: string
  projectId: string
  activeSession: Session | null
  focusTask: Task | null
  now: Task[]
  next: Task[]
  done: Task[]
}

export interface FocusInputs {
  activeSession: Session | null
  inProgress: Task[]
  ready: Task[]
  recentlyDone: Task[]
}

// Mirrors /choda-task-focus tier order: the focus is the strongest EXPLICIT
// signal — active session's bound task > in-progress > ready — never raw
// priority alone. Priority only orders within a bucket.
export function deriveFocus(inputs: FocusInputs): Omit<FocusFeed, 'workspaceId' | 'projectId'> {
  const now = [...inputs.inProgress].sort(byPriority)
  const next = [...inputs.ready].sort(byPriority)
  const done = inputs.recentlyDone
  const sessionTask = inputs.activeSession?.taskId
    ? (now.find((t) => t.id === inputs.activeSession?.taskId) ?? null)
    : null
  const focusTask = sessionTask ?? now[0] ?? next[0] ?? null
  return { activeSession: inputs.activeSession, focusTask, now, next, done }
}

const DONE_LIMIT = 10

async function buildFocusFeed(svc: BackendTaskService, workspaceId: string): Promise<FocusFeed> {
  const workspace = await svc.getWorkspace(workspaceId)
  if (!workspace) throw new WorkflowBadRequestError(`unknown workspaceId: ${workspaceId}`)
  const projectId = workspace.projectId
  const [activeSession, inProgress, ready, doneAll] = await Promise.all([
    svc.getActiveSession(projectId, workspaceId),
    svc.findTasks({ projectId, status: 'IN-PROGRESS' }),
    svc.findTasks({ projectId, status: 'READY' }),
    svc.findTasks({ projectId, status: 'DONE' })
  ])
  // findTasks has no updatedAt sort — newest DONE last by id is a stable proxy.
  const recentlyDone = doneAll.slice(-DONE_LIMIT).reverse()
  return { workspaceId, projectId, ...deriveFocus({ activeSession, inProgress, ready, recentlyDone }) }
}

export class WorkflowBadRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowBadRequestError'
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(payload)
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.length === 0) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new WorkflowBadRequestError('body is not valid JSON'))
      }
    })
    req.on('error', reject)
  })
}

// Route table for the workflow surface. Returns false when the path is not
// ours so http-server falls through to its own routes / 404.
export async function handleWorkflowRoute(
  req: IncomingMessage,
  res: ServerResponse,
  svc: BackendTaskService
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname
  const method = req.method ?? 'GET'
  try {
    if (method === 'GET' && path === '/workflow/focus') {
      const workspaceId = url.searchParams.get('workspaceId')
      if (!workspaceId) throw new WorkflowBadRequestError('workspaceId query param is required')
      sendJson(res, 200, await buildFocusFeed(svc, workspaceId))
      return true
    }
    if (method === 'GET' && path === '/sessions') {
      sendJson(res, 200, await listSessions(svc, url))
      return true
    }
    const readyMatch = path.match(/^\/tasks\/([^/]+)\/ready$/)
    if (method === 'POST' && readyMatch) {
      sendJson(res, 200, await markReady(svc, decodeURIComponent(readyMatch[1])))
      return true
    }
    if (method === 'POST' && path === '/sessions') {
      sendJson(res, 200, await startSession(svc, await readBody(req)))
      return true
    }
    const endMatch = path.match(/^\/sessions\/([^/]+)\/end$/)
    if (method === 'POST' && endMatch) {
      sendJson(res, 200, await endSession(svc, decodeURIComponent(endMatch[1]), await readBody(req)))
      return true
    }
    return false
  } catch (err) {
    if (err instanceof WorkflowBadRequestError) {
      sendJson(res, 400, { error: err.message })
      return true
    }
    throw err
  }
}

async function listSessions(
  svc: BackendTaskService,
  url: URL
): Promise<{ sessions: Session[] }> {
  const workspaceId = url.searchParams.get('workspaceId')
  if (!workspaceId) throw new WorkflowBadRequestError('workspaceId query param is required')
  const workspace = await svc.getWorkspace(workspaceId)
  if (!workspace) throw new WorkflowBadRequestError(`unknown workspaceId: ${workspaceId}`)
  const status = url.searchParams.get('status') ?? 'recent'
  if (status !== 'active' && status !== 'recent') {
    throw new WorkflowBadRequestError('status must be active|recent')
  }
  const all = await svc.findSessions(workspace.projectId, status === 'active' ? 'active' : undefined)
  const scoped = all.filter((s) => s.workspaceId === workspaceId)
  return { sessions: status === 'recent' ? scoped.slice(0, 10) : scoped }
}

// Idempotent-safe: a task already READY returns as-is (200), no error — the
// Cockpit can double-click without a scary failure.
async function markReady(svc: BackendTaskService, taskId: string): Promise<{ task: Task }> {
  const task = await svc.getTask(taskId)
  if (!task) throw new WorkflowBadRequestError(`unknown taskId: ${taskId}`)
  if (task.status === 'READY') return { task }
  if (task.status !== 'TODO') {
    throw new WorkflowBadRequestError(`task ${taskId} is ${task.status} — only TODO can be marked READY`)
  }
  return { task: await svc.updateTask(taskId, { status: 'READY' }) }
}

async function startSession(svc: BackendTaskService, body: unknown): Promise<unknown> {
  const b = (body ?? {}) as { projectId?: string; workspaceId?: string; taskId?: string }
  if (!b.projectId || !b.taskId) {
    throw new WorkflowBadRequestError('projectId and taskId are required')
  }
  return svc.startSession({ projectId: b.projectId, workspaceId: b.workspaceId, taskId: b.taskId })
}

// Light end — the browser can't author a full handoff; a resumePoint is enough.
// Idempotent-safe: ending an already-completed session 400s with a clear reason
// rather than corrupting state.
async function endSession(
  svc: BackendTaskService,
  sessionId: string,
  body: unknown
): Promise<unknown> {
  const session = await svc.getSession(sessionId)
  if (!session) throw new WorkflowBadRequestError(`unknown sessionId: ${sessionId}`)
  if (session.status !== 'active') {
    throw new WorkflowBadRequestError(`session ${sessionId} is not active`)
  }
  const b = (body ?? {}) as { resumePoint?: string }
  return svc.endSession(sessionId, {
    handoff: { resumePoint: b.resumePoint ?? 'ended from companion Cockpit' }
  })
}
