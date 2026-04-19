import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { textResponse } from './types'
import { buildProjectContext, type ProjectContextDeps } from './project-context-builder'
import { loadSessionRules } from '../rules/session-rules-loader'
import { LifecycleError } from '../lifecycle/errors'
import type { SessionHandoff, Task, TaskStatus } from '../task-types'
import type { ProjectOperations } from '../interfaces/project-repository.interface'
import type { SessionOperations } from '../interfaces/session-repository.interface'
import type { TaskOperations } from '../interfaces/task-repository.interface'
import type { SessionLifecycleOperations } from '../interfaces/session-lifecycle.interface'

// Workspaces support N parallel active sessions (TASK-526).
// Status set: 'active' | 'completed' — no auto-abandon on session_start.

export type SessionToolsDeps = ProjectOperations &
  SessionOperations &
  TaskOperations &
  SessionLifecycleOperations &
  ProjectContextDeps

const handoffInputSchema = {
  sessionId: z.string(),
  commits: z.array(z.string()).optional(),
  decisions: z.array(z.string()).optional(),
  resumePoint: z.string(),
  looseEnds: z.array(z.string()).optional(),
  notes: z.string().optional()
}

function tryLifecycle<T>(fn: () => T): ReturnType<typeof textResponse> {
  try {
    return textResponse(fn())
  } catch (e) {
    if (e instanceof LifecycleError) return textResponse(e.message)
    throw e
  }
}

export const register = (server: McpServer, svc: SessionToolsDeps): void => {
  server.registerTool(
    'session_start',
    {
      description:
        'Start a new work session for a project workspace. Returns last handoff + active context. Multiple active sessions per workspace are allowed.',
      inputSchema: {
        projectId: z.string().describe('Project ID'),
        workspaceId: z.string().optional().describe('Workspace ID (e.g. workflow-engine)')
      }
    },
    async ({ projectId, workspaceId }) =>
      tryLifecycle(() => {
        const project = svc.getProject(projectId)
        if (!project) throw new Error(`Project ${projectId} not found`)

        const { session, conversationId, contextSources } = svc.startSession({
          projectId,
          workspaceId
        })
        const lastHandoff = loadLastHandoff(svc, projectId, workspaceId)
        const bundle = buildProjectContext(svc, projectId, 'summary')
        const rules = loadSessionRules()

        return {
          sessionId: session.id,
          workspaceId: session.workspaceId,
          conversationId,
          contextSources,
          mode: 'planning',
          lastHandoff,
          projectSummary: buildProjectSummary(bundle),
          activeTasks: bundle?.currentState.activeTasks ?? [],
          openConversations: bundle?.currentState.openConversations ?? [],
          suggestion: buildSuggestion(lastHandoff, bundle?.currentState.activeTasks ?? []),
          rules: {
            onSessionStart: rules.sessionStart,
            onSessionEnd: rules.sessionEnd
          }
        }
      })
  )

  server.registerTool(
    'session_pick',
    {
      description:
        'Pick a task for the current session. Sets task to IN-PROGRESS. Only 1 task per session (WIP=1).',
      inputSchema: {
        sessionId: z.string(),
        taskId: z.string().describe('Task ID to work on')
      }
    },
    async ({ sessionId, taskId }) => {
      const session = svc.getSession(sessionId)
      if (!session) return textResponse(`Session ${sessionId} not found`)
      if (session.status !== 'active') {
        return textResponse(`Session ${sessionId} is ${session.status}, not active`)
      }
      if (session.taskId) {
        return textResponse(`Session already has task ${session.taskId}. Finish it first.`)
      }

      const task = svc.getTask(taskId)
      if (!task) return textResponse(`Task ${taskId} not found`)

      svc.updateSession(sessionId, { taskId })
      svc.updateTask(taskId, { status: 'IN-PROGRESS' })

      return textResponse({
        sessionId,
        taskId,
        taskTitle: task.title,
        mode: 'focused',
        status: 'IN-PROGRESS'
      })
    }
  )

  server.registerTool(
    'session_end',
    {
      description: 'End a work session. If session has a task, marks it DONE. Persists handoff.',
      inputSchema: handoffInputSchema
    },
    async (input) =>
      tryLifecycle(() => {
        const handoff: SessionHandoff = {
          commits: input.commits,
          decisions: input.decisions,
          resumePoint: input.resumePoint,
          looseEnds: input.looseEnds,
          tasksUpdated: []
        }
        const result = svc.endSession(input.sessionId, { handoff })
        if (result.taskUpdated) handoff.tasksUpdated = [result.taskUpdated.id]

        return {
          sessionId: result.session.id,
          status: result.session.status,
          endedAt: result.session.endedAt,
          taskUpdated: result.taskUpdated,
          closedConversationIds: result.closedConversationIds,
          notes: input.notes
        }
      })
  )
}

export function loadLastHandoff(
  svc: SessionOperations,
  projectId: string,
  workspaceId?: string
): { sessionId: string; endedAt: string | null; handoff: SessionHandoff } | null {
  const completed = svc.findSessions(projectId, 'completed')
  const match = workspaceId ? completed.find((s) => s.workspaceId === workspaceId) : completed[0]
  if (!match) return null
  return {
    sessionId: match.id,
    endedAt: match.endedAt,
    handoff: match.handoff ?? {}
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
  svc: TaskOperations,
  updates?: Array<{ id: string; status: TaskStatus }>
): Array<{ id: string; title: string; oldStatus: TaskStatus; newStatus: TaskStatus }> {
  if (!updates || updates.length === 0) return []
  const out: Array<{ id: string; title: string; oldStatus: TaskStatus; newStatus: TaskStatus }> = []
  for (const u of updates) {
    const before = svc.getTask(u.id)
    if (!before) continue
    const after = svc.updateTask(u.id, { status: u.status })
    out.push({
      id: after.id,
      title: after.title,
      oldStatus: before.status,
      newStatus: after.status
    })
  }
  return out
}
