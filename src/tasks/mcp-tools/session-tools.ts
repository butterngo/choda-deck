import { z } from 'zod'
import { textResponse, type Register } from './types'
import { buildProjectContext } from './project-context-builder'
import { exportHandoffMarkdown } from './session-handoff-exporter'
import { now } from '../repositories/shared'
import type { SqliteTaskService } from '../sqlite-task-service'
import type { SessionHandoff, Task, TaskStatus } from '../task-types'

const taskStatusSchema = z.enum(['TODO', 'READY', 'IN-PROGRESS', 'DONE'])

const handoffInputSchema = {
  sessionId: z.string(),
  commits: z.array(z.string()).optional(),
  decisions: z.array(z.string()).optional(),
  resumePoint: z.string(),
  looseEnds: z.array(z.string()).optional(),
  tasksUpdated: z.array(z.object({
    id: z.string(),
    status: taskStatusSchema
  })).optional(),
  notes: z.string().optional()
}

export const register: Register = (server, svc) => {
  server.registerTool(
    'session_start',
    {
      description: 'Start a new work session for a project. Creates the session, abandons any stale active session, and returns the last handoff + current active context to resume on.',
      inputSchema: { projectId: z.string().describe('Project ID') }
    },
    async ({ projectId }) => {
      const project = svc.getProject(projectId)
      if (!project) return textResponse(`Project ${projectId} not found`)

      const abandoned = abandonStaleSession(svc, projectId)
      const session = svc.createSession({ projectId, startedAt: now(), status: 'active' })
      const lastHandoff = loadLastHandoff(svc, projectId)
      const bundle = buildProjectContext(svc, projectId, 'summary')

      return textResponse({
        sessionId: session.id,
        abandonedSession: abandoned,
        lastHandoff,
        projectSummary: buildProjectSummary(bundle),
        activeTasks: bundle?.currentState.activeTasks ?? [],
        openConversations: bundle?.currentState.openConversations ?? [],
        suggestion: buildSuggestion(lastHandoff, bundle?.currentState.activeTasks ?? [])
      })
    }
  )

  server.registerTool(
    'session_end',
    {
      description: 'End a work session: persist handoff (commits, decisions, resumePoint, looseEnds), optionally update task statuses, and auto-generate handoff.md in the vault.',
      inputSchema: handoffInputSchema
    },
    async (input) => {
      const session = svc.getSession(input.sessionId)
      if (!session) return textResponse(`Session ${input.sessionId} not found`)

      const tasksUpdated = applyTaskUpdates(svc, input.tasksUpdated)

      const handoff: SessionHandoff = {
        commits: input.commits,
        decisions: input.decisions,
        resumePoint: input.resumePoint,
        looseEnds: input.looseEnds,
        tasksUpdated: tasksUpdated.map(t => t.id)
      }

      const updated = svc.updateSession(input.sessionId, {
        status: 'completed',
        endedAt: now(),
        handoff
      })

      const exportedTo = exportHandoffMarkdown(svc, updated.id)

      return textResponse({
        sessionId: updated.id,
        status: updated.status,
        endedAt: updated.endedAt,
        tasksUpdated,
        exportedTo,
        notes: input.notes
      })
    }
  )
}

export function abandonStaleSession(svc: SqliteTaskService, projectId: string): { id: string; startedAt: string } | null {
  const active = svc.getActiveSession(projectId)
  if (!active) return null
  svc.updateSession(active.id, { status: 'abandoned', endedAt: now() })
  return { id: active.id, startedAt: active.startedAt }
}

export function loadLastHandoff(svc: SqliteTaskService, projectId: string): {
  sessionId: string
  endedAt: string | null
  handoff: SessionHandoff
} | null {
  const completed = svc.findSessions(projectId, 'completed')
  const latest = completed[0]
  if (!latest) return null
  return {
    sessionId: latest.id,
    endedAt: latest.endedAt,
    handoff: latest.handoff ?? {}
  }
}

function buildProjectSummary(bundle: ReturnType<typeof buildProjectContext>): string | null {
  if (!bundle) return null
  const pieces: string[] = []
  if (bundle.currentState.activePhase) {
    const p = bundle.currentState.activePhase
    pieces.push(`Phase: ${p.title} (${p.progress.percent}% done)`)
  }
  if (bundle.architecture) {
    pieces.push(bundle.architecture.split('\n').slice(0, 3).join(' ').slice(0, 200))
  }
  return pieces.length > 0 ? pieces.join(' — ') : null
}

function buildSuggestion(
  lastHandoff: ReturnType<typeof loadLastHandoff>,
  activeTasks: Array<Pick<Task, 'id' | 'title' | 'status' | 'priority'>>
): string {
  if (lastHandoff?.handoff.resumePoint) {
    return `Resume: ${lastHandoff.handoff.resumePoint}`
  }
  const firstActive = activeTasks[0]
  if (firstActive) {
    return `Pick up ${firstActive.id} — ${firstActive.title}`
  }
  return 'No obvious resume point — review roadmap or pick a TODO'
}

export function applyTaskUpdates(
  svc: SqliteTaskService,
  updates?: Array<{ id: string; status: TaskStatus }>
): Array<{ id: string; title: string; oldStatus: TaskStatus; newStatus: TaskStatus }> {
  if (!updates || updates.length === 0) return []
  const out: Array<{ id: string; title: string; oldStatus: TaskStatus; newStatus: TaskStatus }> = []
  for (const u of updates) {
    const before = svc.getTask(u.id)
    if (!before) continue
    const after = svc.updateTask(u.id, { status: u.status })
    out.push({ id: after.id, title: after.title, oldStatus: before.status, newStatus: after.status })
  }
  return out
}
