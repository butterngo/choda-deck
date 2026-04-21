import type Database from 'better-sqlite3'
import type { InboxRepository } from '../repositories/inbox-repository'
import type { ConversationRepository } from '../repositories/conversation-repository'
import type { TaskRepository } from '../repositories/task-repository'
import type {
  InboxLifecycleOperations,
  InboxResearchResult,
  InboxConvertInput,
  InboxConvertResult
} from '../interfaces/inbox-lifecycle.interface'
import type { InboxItem } from '../task-types'
import { InboxNotFoundError, InboxStatusError, InboxConflictError } from './errors'

export class InboxLifecycleService implements InboxLifecycleOperations {
  constructor(
    private readonly db: Database.Database,
    private readonly inbox: InboxRepository,
    private readonly conversations: ConversationRepository,
    private readonly tasks: TaskRepository
  ) {}

  startInboxResearch(id: string, researcher: string): InboxResearchResult {
    const tx = this.db.transaction((): InboxResearchResult => {
      const item = this.inbox.get(id)
      if (!item) throw new InboxNotFoundError(id)
      if (item.status !== 'raw') {
        throw new InboxStatusError(id, item.status, 'cannot start research (must be raw)')
      }
      const existing = this.conversations.findByLink('inbox', id)
      if (existing.length > 0) {
        throw new InboxConflictError(id, `already has conversation ${existing[0].id}`)
      }
      const projectId = item.projectId ?? 'global'
      const conv = this.conversations.create({
        projectId,
        title: `Research: ${item.content.slice(0, 80)}`,
        createdBy: researcher,
        status: 'open',
        participants: [
          { name: 'Butter', type: 'human' },
          { name: researcher, type: 'agent' }
        ]
      })
      this.conversations.link(conv.id, 'inbox', id)
      this.inbox.update(id, { status: 'researching' })
      return { inboxId: id, conversationId: conv.id, status: 'researching' }
    })
    return tx()
  }

  convertInboxToTask(id: string, input: InboxConvertInput): InboxConvertResult {
    const tx = this.db.transaction((): InboxConvertResult => {
      const item = this.inbox.get(id)
      if (!item) throw new InboxNotFoundError(id)
      if (item.status === 'converted' || item.status === 'archived') {
        throw new InboxStatusError(id, item.status, 'cannot convert')
      }
      if (!item.projectId) {
        throw new InboxConflictError(id, 'no projectId — assign one before converting')
      }
      const task = this.tasks.create({
        projectId: item.projectId,
        title: input.title,
        priority: input.priority,
        labels: input.labels,
        status: 'TODO'
      })
      if (input.body) this.tasks.update(task.id, { body: input.body })
      this.inbox.update(id, { status: 'converted', linkedTaskId: task.id })
      this.closeLinkedConversations(id, `Converted to ${task.id}: ${input.title}`)
      const final = this.tasks.get(task.id)
      if (!final) throw new Error(`Task ${task.id} disappeared mid-transaction`)
      return { inboxId: id, taskId: task.id, task: final }
    })
    return tx()
  }

  archiveInbox(id: string, reason?: string): InboxItem {
    const tx = this.db.transaction((): InboxItem => {
      const item = this.inbox.get(id)
      if (!item) throw new InboxNotFoundError(id)
      if (item.status === 'converted') {
        throw new InboxStatusError(id, item.status, 'already converted — cannot archive')
      }
      this.inbox.update(id, { status: 'archived' })
      this.closeLinkedConversations(id, reason ? `Archived: ${reason}` : 'Archived')
      const final = this.inbox.get(id)
      if (!final) throw new Error(`Inbox ${id} disappeared mid-transaction`)
      return final
    })
    return tx()
  }

  private closeLinkedConversations(inboxId: string, decisionSummary: string): void {
    const convs = this.conversations.findByLink('inbox', inboxId)
    if (convs.length === 0) return
    const closedAt = new Date().toISOString()
    for (const c of convs) {
      if (c.status !== 'closed') {
        this.conversations.update(c.id, { status: 'closed', decisionSummary, closedAt })
      }
    }
  }
}
