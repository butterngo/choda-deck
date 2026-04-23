import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { textResponse } from './types'
import { buildProjectContext, type ProjectContextDeps } from './project-context-builder'
import { loadSessionRules } from '../rules/session-rules-loader'
import { LifecycleError } from '../../../core/domain/lifecycle/errors'
import type { Session, SessionCheckpoint, SessionHandoff, Task, TaskStatus } from '../../../core/domain/task-types'
import type { ProjectOperations } from '../../../core/domain/interfaces/project-repository.interface'
import type { SessionOperations } from '../../../core/domain/interfaces/session-repository.interface'
import type { TaskOperations } from '../../../core/domain/interfaces/task-repository.interface'
import type { SessionLifecycleOperations } from '../../../core/domain/interfaces/session-lifecycle.interface'

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
        'Start a new work session bound to a specific task. Sets the task to IN-PROGRESS and returns last handoff + active context. Call task_list or roadmap first to pick a taskId. Multiple active sessions per workspace are allowed, but a task can only be linked to one active session at a time.',
      inputSchema: {
        projectId: z.string().describe('Project ID'),
        taskId: z
          .string()
          .describe('Task ID to work on — set to IN-PROGRESS when the session starts'),
        workspaceId: z.string().optional().describe('Workspace ID (e.g. workflow-engine)')
      }
    },
    async ({ projectId, taskId, workspaceId }) =>
      tryLifecycle(() => {
        const project = svc.getProject(projectId)
        if (!project) throw new Error(`Project ${projectId} not found`)

        const { session, contextSources, existingActiveSessions } = svc.startSession({
          projectId,
          taskId,
          workspaceId
        })
        const lastSession = loadLastSession(svc, projectId, workspaceId)
        const bundle = buildProjectContext(svc, projectId, 'summary')
        const rules = loadSessionRules()

        return {
          sessionId: session.id,
          workspaceId: session.workspaceId,
          contextSources,
          mode: 'planning',
          lastSession,
          existingActiveSessions: summarizeActiveSessions(existingActiveSessions),
          projectSummary: buildProjectSummary(bundle),
          activeTasks: bundle?.currentState.activeTasks ?? [],
          openConversations: bundle?.currentState.openConversations ?? [],
          suggestion: buildSuggestion(lastSession, bundle?.currentState.activeTasks ?? []),
          rules: {
            onSessionStart: rules.sessionStart,
            onSessionEnd: rules.sessionEnd
          }
        }
      })
  )

  server.registerTool(
    'session_list',
    {
      description:
        'List sessions for a project, sorted by startedAt DESC. Handoff excluded by default (set includeHandoff=true to include).',
      inputSchema: {
        projectId: z.string().describe('Project ID'),
        status: z.enum(['active', 'completed']).optional(),
        workspaceId: z.string().optional().describe('Filter by workspace ID'),
        limit: z.number().int().positive().optional().describe('Max results (default 50)'),
        includeHandoff: z.boolean().optional().describe('Include handoff JSON (default false)')
      }
    },
    async ({ projectId, status, workspaceId, limit, includeHandoff }) => {
      const all = svc.findSessions(projectId, status)
      const filtered = workspaceId ? all.filter((s) => s.workspaceId === workspaceId) : all
      const sliced = filtered.slice(0, limit ?? 50)
      const out = sliced.map((s) => {
        const base = {
          id: s.id,
          projectId: s.projectId,
          workspaceId: s.workspaceId,
          taskId: s.taskId,
          startedAt: s.startedAt,
          endedAt: s.endedAt,
          status: s.status
        }
        return includeHandoff ? { ...base, handoff: s.handoff } : base
      })
      return textResponse({ total: out.length, sessions: out })
    }
  )

  server.registerTool(
    'session_checkpoint',
    {
      description:
        'Snapshot current progress on an active session without ending it. Overwrite-in-place — each call replaces the previous checkpoint. Use when pausing work or before risky ops so a future session_resume can pick up state after crash/restart.',
      inputSchema: {
        sessionId: z.string(),
        resumePoint: z.string().optional().describe('One-line pointer to where you stopped'),
        notes: z.string().optional().describe('Free-form context — what matters for resume'),
        lastConversationId: z.string().optional().describe('Most recent conversation touched'),
        dirtyFiles: z
          .array(z.string())
          .optional()
          .describe('Files edited but not yet committed'),
        lastCommit: z.string().optional().describe('Last commit SHA written in this session')
      }
    },
    async ({ sessionId, resumePoint, notes, lastConversationId, dirtyFiles, lastCommit }) =>
      tryLifecycle(() => {
        const checkpoint: SessionCheckpoint = {
          resumePoint,
          notes,
          lastConversationId,
          dirtyFiles,
          lastCommit
        }
        const result = svc.checkpointSession(sessionId, { checkpoint })
        return {
          sessionId: result.session.id,
          status: result.session.status,
          checkpoint: result.session.checkpoint,
          checkpointAt: result.session.checkpointAt
        }
      })
  )

  server.registerTool(
    'session_resume',
    {
      description:
        'Resume a previously-active session after crash or restart. Returns session row, last checkpoint (if any), linked conversations, and active context sources. Works on completed sessions too (read-only replay).',
      inputSchema: {
        sessionId: z.string()
      }
    },
    async ({ sessionId }) =>
      tryLifecycle(() => {
        const result = svc.resumeSession(sessionId)
        return {
          session: result.session,
          checkpoint: result.checkpoint,
          conversations: result.conversations,
          contextSources: result.contextSources
        }
      })
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

export interface LastSessionSummary {
  id: string
  endedAt: string | null
  resumePoint: string | null
  decisions: string[]
  commits: string[]
  looseEnds: string[]
  tasksUpdated: string[]
}

export function loadLastSession(
  svc: SessionOperations,
  projectId: string,
  workspaceId?: string
): LastSessionSummary | null {
  const completed = svc.findSessions(projectId, 'completed')
  const match = workspaceId ? completed.find((s) => s.workspaceId === workspaceId) : completed[0]
  if (!match) return null
  const h: SessionHandoff = match.handoff ?? {}
  return {
    id: match.id,
    endedAt: match.endedAt,
    resumePoint: h.resumePoint ?? null,
    decisions: h.decisions ?? [],
    commits: h.commits ?? [],
    looseEnds: h.looseEnds ?? [],
    tasksUpdated: h.tasksUpdated ?? []
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

function summarizeActiveSessions(
  sessions: Session[]
): Array<{
  id: string
  workspaceId: string | null
  taskId: string | null
  startedAt: string
  hasCheckpoint: boolean
  checkpointAt: string | null
  hint: string
}> {
  return sessions.map((s) => ({
    id: s.id,
    workspaceId: s.workspaceId,
    taskId: s.taskId,
    startedAt: s.startedAt,
    hasCheckpoint: s.checkpoint !== null,
    checkpointAt: s.checkpointAt,
    hint: s.checkpoint
      ? 'Consider session_resume instead of starting new — this session has a checkpoint'
      : 'Session still active — resume or intentional parallel session?'
  }))
}

function buildSuggestion(
  lastSession: LastSessionSummary | null,
  activeTasks: Array<Pick<Task, 'id' | 'title' | 'status' | 'priority'>>
): string {
  if (lastSession?.resumePoint) {
    return `Resume: ${lastSession.resumePoint}`
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
