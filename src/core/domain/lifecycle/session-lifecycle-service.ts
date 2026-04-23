import type Database from 'better-sqlite3'
import type { SessionRepository } from '../repositories/session-repository'
import type { ContextSourceRepository } from '../repositories/context-source-repository'
import type { ConversationRepository } from '../repositories/conversation-repository'
import type { TaskRepository } from '../repositories/task-repository'
import type {
  CheckpointSessionInput,
  CheckpointSessionResult,
  EndSessionInput,
  EndSessionResult,
  ResumeSessionResult,
  SessionLifecycleOperations,
  StartSessionInput,
  StartSessionResult
} from '../interfaces/session-lifecycle.interface'
import { now } from '../repositories/shared'
import {
  SessionNotFoundError,
  SessionStatusError,
  TaskLockedBySessionError,
  TaskNotFoundError,
  TaskStatusError
} from './errors'

export class SessionLifecycleService implements SessionLifecycleOperations {
  constructor(
    private readonly db: Database.Database,
    private readonly sessions: SessionRepository,
    private readonly contextSources: ContextSourceRepository,
    private readonly conversations: ConversationRepository,
    private readonly tasks: TaskRepository
  ) {}

  startSession(input: StartSessionInput): StartSessionResult {
    const tx = this.db.transaction((): StartSessionResult => {
      const existingActiveSessions = this.sessions.findByProject(input.projectId, 'active')

      if (input.taskId) {
        const task = this.tasks.get(input.taskId)
        if (!task) throw new TaskNotFoundError(input.taskId)
        if (task.status === 'DONE') {
          throw new TaskStatusError(
            input.taskId,
            task.status,
            'cannot start a session on a DONE task — reopen it first'
          )
        }
        const lockingSession = existingActiveSessions.find((s) => s.taskId === input.taskId)
        if (lockingSession) throw new TaskLockedBySessionError(input.taskId, lockingSession.id)
      }

      const session = this.sessions.create({
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        taskId: input.taskId,
        startedAt: now(),
        status: 'active'
      })

      if (input.taskId) {
        this.tasks.update(input.taskId, { status: 'IN-PROGRESS' })
      }

      const contextSources = this.contextSources.findByProject(input.projectId, true)

      return { session, contextSources, existingActiveSessions }
    })
    return tx()
  }

  endSession(id: string, input: EndSessionInput): EndSessionResult {
    const tx = this.db.transaction((): EndSessionResult => {
      const session = this.sessions.get(id)
      if (!session) throw new SessionNotFoundError(id)
      if (session.status !== 'active') {
        throw new SessionStatusError(id, session.status, 'only active sessions can end')
      }

      const endedAt = now()
      const decisionSummary = input.decisionSummary ?? input.handoff.resumePoint ?? 'Session ended'

      const closedConversationIds: string[] = []
      const linkedConvs = this.conversations.findByLink('session', id)
      for (const conv of linkedConvs) {
        if (conv.status === 'closed') continue
        this.conversations.update(conv.id, {
          status: 'closed',
          decisionSummary,
          closedAt: endedAt
        })
        closedConversationIds.push(conv.id)
      }

      let taskUpdated: EndSessionResult['taskUpdated'] = null
      if (session.taskId) {
        const task = this.tasks.get(session.taskId)
        if (task) {
          this.tasks.update(session.taskId, { status: 'DONE' })
          taskUpdated = { id: task.id, title: task.title, newStatus: 'DONE' }
        }
      }

      const updated = this.sessions.update(id, {
        status: 'completed',
        endedAt,
        handoff: input.handoff
      })

      return { session: updated, closedConversationIds, taskUpdated }
    })
    return tx()
  }

  checkpointSession(id: string, input: CheckpointSessionInput): CheckpointSessionResult {
    const session = this.sessions.get(id)
    if (!session) throw new SessionNotFoundError(id)
    if (session.status !== 'active') {
      throw new SessionStatusError(id, session.status, 'only active sessions can checkpoint')
    }

    const updated = this.sessions.update(id, {
      checkpoint: input.checkpoint,
      checkpointAt: now()
    })
    return { session: updated }
  }

  resumeSession(id: string): ResumeSessionResult {
    const session = this.sessions.get(id)
    if (!session) throw new SessionNotFoundError(id)

    const conversations = this.conversations.findByLink('session', id)
    const contextSources = this.contextSources.findByProject(session.projectId, true)

    return {
      session,
      checkpoint: session.checkpoint,
      conversations,
      contextSources
    }
  }
}
