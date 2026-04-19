import type Database from 'better-sqlite3'
import type { ConversationRepository } from '../repositories/conversation-repository'
import type { TaskRepository } from '../repositories/task-repository'
import type {
  ConversationLifecycleOperations,
  OpenConversationInput,
  DecideConversationInput,
  DecideConversationResult,
  DecideConversationResultAction
} from '../interfaces/conversation-lifecycle.interface'
import type { Conversation } from '../task-types'
import { now } from '../repositories/shared'
import {
  ConversationNotFoundError,
  ConversationStatusError,
  ConversationConflictError
} from './errors'

export class ConversationLifecycleService implements ConversationLifecycleOperations {
  constructor(
    private readonly db: Database.Database,
    private readonly conversations: ConversationRepository,
    private readonly tasks: TaskRepository
  ) {}

  openConversation(input: OpenConversationInput): Conversation {
    const tx = this.db.transaction((): Conversation => {
      this.assertNoBlockingConversations(input.projectId)

      const conv = this.conversations.create({
        projectId: input.projectId,
        title: input.title,
        createdBy: input.createdBy,
        participants: input.participants
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

      const final = this.conversations.get(conv.id)
      if (!final) throw new Error(`Conversation ${conv.id} disappeared mid-transaction`)
      return final
    })
    return tx()
  }

  decideConversation(id: string, input: DecideConversationInput): DecideConversationResult {
    const tx = this.db.transaction((): DecideConversationResult => {
      const conv = this.conversations.get(id)
      if (!conv) throw new ConversationNotFoundError(id)

      this.conversations.addMessage({
        conversationId: id,
        authorName: input.author,
        content: input.decision,
        messageType: 'decision'
      })

      const decidedAt = now()
      const updated = this.conversations.update(id, {
        status: 'decided',
        decisionSummary: input.decision,
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
      if (conv.status !== 'decided') {
        throw new ConversationStatusError(id, conv.status, 'only decided conversations can reopen')
      }
      const active = [
        ...this.conversations.findByProject(conv.projectId, 'open'),
        ...this.conversations.findByProject(conv.projectId, 'discussing')
      ]
      if (active.length > 0) {
        throw new ConversationConflictError(
          `Cannot reopen ${id}: ${active[0].id} is already ${active[0].status}`
        )
      }
      return this.conversations.update(id, { status: 'discussing' })
    })
    return tx()
  }

  private assertNoBlockingConversations(projectId: string): void {
    const active = [
      ...this.conversations.findByProject(projectId, 'open'),
      ...this.conversations.findByProject(projectId, 'discussing')
    ]
    if (active.length > 0) {
      throw new ConversationConflictError(
        `Cannot open: ${active[0].id} "${active[0].title}" is ${active[0].status}. Finish it first.`
      )
    }
    const decided = this.conversations.findByProject(projectId, 'decided')
    if (decided.length > 0) {
      const ids = decided.map((c) => c.id).join(', ')
      throw new ConversationConflictError(
        `Cannot open: ${decided.length} decided conversation(s) not closed yet (${ids}). Use conversation_close first.`
      )
    }
  }

  private createActionAndMaybeSpawnTask(
    projectId: string,
    conversationId: string,
    action: { assignee: string; description: string; spawnTask?: { title: string; priority?: 'critical' | 'high' | 'medium' | 'low' } }
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
