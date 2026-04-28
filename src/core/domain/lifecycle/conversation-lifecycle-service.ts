import type Database from 'better-sqlite3'
import type { ConversationRepository } from '../repositories/conversation-repository'
import type { TaskRepository } from '../repositories/task-repository'
import type { SessionRepository } from '../repositories/session-repository'
import type {
  ConversationLifecycleOperations,
  OpenConversationInput,
  DecideConversationInput,
  DecideConversationResult,
  DecideConversationResultAction
} from '../interfaces/conversation-lifecycle.interface'
import type { Conversation } from '../task-types'
import { now } from '../repositories/shared'
import { ConversationNotFoundError, ConversationStatusError } from './errors'
import { stripToolCallLeak } from './sanitize'

export class ConversationLifecycleService implements ConversationLifecycleOperations {
  constructor(
    private readonly db: Database.Database,
    private readonly conversations: ConversationRepository,
    private readonly tasks: TaskRepository,
    private readonly sessions: SessionRepository
  ) {}

  openConversation(input: OpenConversationInput): Conversation {
    const tx = this.db.transaction((): Conversation => {
      const resolvedSessionId = this.resolveSessionId(input.projectId, input.sessionId)

      const conv = this.conversations.create({
        projectId: input.projectId,
        title: input.title,
        createdBy: input.createdBy,
        participants: input.participants,
        ownerType: 'interactive',
        ownerSessionId: resolvedSessionId ?? undefined
      })

      this.conversations.addMessage({
        conversationId: conv.id,
        authorName: input.createdBy,
        content: input.initialMessage.content,
        messageType: input.initialMessage.type
      })

      for (const taskId of input.linkedTasks ?? []) {
        this.conversations.link(conv.id, 'task', taskId)
      }

      if (resolvedSessionId) {
        this.conversations.link(conv.id, 'session', resolvedSessionId)
      }

      const final = this.conversations.get(conv.id)
      if (!final) throw new Error(`Conversation ${conv.id} disappeared mid-transaction`)
      return final
    })
    return tx()
  }

  private resolveSessionId(projectId: string, explicit?: string): string | null {
    if (explicit !== undefined) {
      const session = this.sessions.get(explicit)
      if (!session) throw new Error(`Session ${explicit} not found`)
      if (session.status !== 'active') throw new Error(`Session ${explicit} is not active`)
      if (session.projectId !== projectId) {
        throw new Error(
          `Session ${explicit} belongs to project ${session.projectId}, not ${projectId}`
        )
      }
      return explicit
    }

    const active = this.sessions.findByProject(projectId, 'active')
    if (active.length === 1) return active[0].id
    if (active.length > 1) {
      console.warn(
        `[ConversationLifecycle] ${active.length} active sessions in project ${projectId} — skipping auto-link`
      )
    }
    return null
  }

  decideConversation(id: string, input: DecideConversationInput): DecideConversationResult {
    const tx = this.db.transaction((): DecideConversationResult => {
      const conv = this.conversations.get(id)
      if (!conv) throw new ConversationNotFoundError(id)

      const cleanDecision = stripToolCallLeak(input.decision)

      this.conversations.addMessage({
        conversationId: id,
        authorName: input.author,
        content: cleanDecision,
        messageType: 'decision'
      })

      const decidedAt = now()
      const updated = this.conversations.update(id, {
        status: 'decided',
        decisionSummary: cleanDecision,
        decidedAt
      })

      const actions: DecideConversationResultAction[] = (input.actions ?? []).map((action) =>
        this.createActionAndMaybeSpawnTask(conv.projectId, id, action)
      )

      return { conversation: updated, actions }
    })
    return tx()
  }

  closeConversation(id: string): Conversation {
    const tx = this.db.transaction((): Conversation => {
      const conv = this.conversations.get(id)
      if (!conv) throw new ConversationNotFoundError(id)
      if (conv.status !== 'decided') {
        throw new ConversationStatusError(id, conv.status, 'must be decided before closing')
      }
      return this.conversations.update(id, { status: 'closed', closedAt: now() })
    })
    return tx()
  }

  reopenConversation(id: string): Conversation {
    const tx = this.db.transaction((): Conversation => {
      const conv = this.conversations.get(id)
      if (!conv) throw new ConversationNotFoundError(id)
      if (conv.status !== 'decided' && conv.status !== 'closed') {
        throw new ConversationStatusError(
          id,
          conv.status,
          'only decided or closed conversations can reopen'
        )
      }
      return this.conversations.update(id, { status: 'discussing' })
    })
    return tx()
  }

  private createActionAndMaybeSpawnTask(
    projectId: string,
    conversationId: string,
    action: {
      assignee: string
      description: string
      spawnTask?: { title: string; priority?: 'critical' | 'high' | 'medium' | 'low' }
    }
  ): DecideConversationResultAction {
    let linkedTaskId: string | undefined
    if (action.spawnTask) {
      const task = this.tasks.create({
        projectId,
        title: action.spawnTask.title,
        priority: action.spawnTask.priority,
        labels: [`assignee:${action.assignee}`]
      })
      linkedTaskId = task.id
      this.conversations.link(conversationId, 'task', task.id)
    }
    const created = this.conversations.addAction({
      conversationId,
      assignee: action.assignee,
      description: action.description,
      linkedTaskId
    })
    return {
      id: created.id,
      assignee: created.assignee,
      description: created.description,
      linkedTaskId: created.linkedTaskId
    }
  }
}
