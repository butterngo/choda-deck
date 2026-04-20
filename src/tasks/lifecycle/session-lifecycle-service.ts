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
  PipelineActiveBlockingError,
  SessionNotFoundError,
  SessionStatusError
} from './errors'

const DEFAULT_PARTICIPANTS: StartSessionInput['participants'] = [
  { name: 'Butter', type: 'human' },
  { name: 'Claude', type: 'agent' }
]

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
      this.assertNoActivePipeline(input.projectId)

      const existingActiveSessions = this.sessions.findByProject(input.projectId, 'active')

      const session = this.sessions.create({
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        startedAt: now(),
        status: 'active'
      })

      const contextSources = this.contextSources.findByProject(input.projectId, true)

      const createdBy = input.createdBy ?? 'Claude'
      const participants = input.participants ?? DEFAULT_PARTICIPANTS
      const title = `Session ${session.id}${input.workspaceId ? ` — ${input.workspaceId}` : ''}`

      const conv = this.conversations.create({
        projectId: input.projectId,
        title,
        createdBy,
        status: 'open',
        participants,
        ownerType: 'interactive',
        ownerSessionId: session.id
      })
      this.conversations.link(conv.id, 'session', session.id)

      return { session, conversationId: conv.id, contextSources, existingActiveSessions }
    })
    return tx()
  }

  private assertNoActivePipeline(projectId: string): void {
    const pipelines = this.sessions
      .findActivePipelines()
      .filter((p) => p.projectId === projectId)
    if (pipelines.length === 0) return
    const p = pipelines[0]
    throw new PipelineActiveBlockingError({
      owner_type: 'pipeline',
      owner_session_id: p.sessionId,
      owner_task_id: p.taskId ?? null,
      stage: p.stage as 'plan' | 'generate' | 'evaluate',
      started_at: p.startedAt
    })
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
