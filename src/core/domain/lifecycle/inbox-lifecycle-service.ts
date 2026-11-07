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
import {
  InboxNotFoundError,
  InboxStatusError,
  InboxConflictError,
  InboxTemplateError
} from './errors'
import { templateViolations } from './task-template'

export class InboxLifecycleService implements InboxLifecycleOperations {
  constructor(
    private readonly db: Database.Database,
    private readonly inbox: InboxRepository,
    private readonly conversations: ConversationRepository,
    private readonly tasks: TaskRepository
  ) {}

  async startInboxResearch(id: string, researcher: string): Promise<InboxResearchResult> {
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
        participants: [{ name: 'Butter' }, { name: researcher }]
      })
      this.conversations.link(conv.id, 'inbox', id)
      this.inbox.update(id, { status: 'researching' })
      return { inboxId: id, conversationId: conv.id, status: 'researching' }
    })
    return tx()
  }

  async convertInboxToTask(id: string, input: InboxConvertInput): Promise<InboxConvertResult> {
    const tx = this.db.transaction((): InboxConvertResult => {
      const item = this.inbox.get(id)
      if (!item) throw new InboxNotFoundError(id)
      if (item.status === 'converted' || item.status === 'archived') {
        throw new InboxStatusError(id, item.status, 'cannot convert')
      }
      if (!item.projectId) {
        throw new InboxConflictError(id, 'no projectId — assign one before converting')
      }
      // TASK-2247 — refuse before anything is written: no task, no status change.
      const violations = templateViolations(input.body)
      if (violations.length > 0) throw new InboxTemplateError(id, violations)
      const task = this.tasks.create({
        projectId: item.projectId,
        title: input.title,
        priority: input.priority,
        labels: input.labels,
        assignee: input.assignee,
        status: 'TODO'
      })
      if (input.body) this.tasks.update(task.id, { body: input.body })
      this.inbox.update(id, { status: 'converted', linkedTaskId: task.id })
      this.closeLinkedConversations(id, `Converted to ${task.id}: ${input.title}`, 'inbox_convert')
      const final = this.tasks.get(task.id)
      if (!final) throw new Error(`Task ${task.id} disappeared mid-transaction`)
      // Progressive localization (ADR-032 Pillar 6): soft-warn, never gate. If the
      // idea was never localized to a workspace, the converted task carries no
      // app scope — surface a nudge rather than blocking the conversion.
      const localizationWarning = item.workspaceId
        ? undefined
        : `${id} had no workspaceId — converted ${task.id} is not localized to an app. Set it during research (inbox_ready) next time, or scope the task via its worker session.`
      return { inboxId: id, taskId: task.id, task: final, localizationWarning }
    })
    return tx()
  }

  async archiveInbox(id: string, reason?: string): Promise<InboxItem> {
    const tx = this.db.transaction((): InboxItem => {
      const item = this.inbox.get(id)
      if (!item) throw new InboxNotFoundError(id)
      if (item.status === 'converted') {
        throw new InboxStatusError(id, item.status, 'already converted — cannot archive')
      }
      this.inbox.update(id, { status: 'archived' })
      this.closeLinkedConversations(id, reason ? `Archived: ${reason}` : 'Archived', 'inbox_archive')
      const final = this.inbox.get(id)
      if (!final) throw new Error(`Inbox ${id} disappeared mid-transaction`)
      return final
    })
    return tx()
  }

  // TASK-3140 — close through the append-only log (TASK-1067), never by writing
  // the header: a direct write is erased by the next refold. The inbox action IS
  // Butter's decision, so each registered participant not yet signed off gets a
  // signoff turn attributed to the action; otherwise every research thread
  // (participants Butter + researcher) would fold back to `open`. Idempotent
  // when the conversation is already `decided`.
  private closeLinkedConversations(
    inboxId: string,
    decisionSummary: string,
    actor: 'inbox_convert' | 'inbox_archive'
  ): void {
    for (const c of this.conversations.findByLink('inbox', inboxId)) {
      if (c.status === 'decided') continue
      this.conversations.addMessage({
        conversationId: c.id,
        authorName: actor,
        content: decisionSummary,
        kind: 'decision'
      })
      const signed = new Set(
        this.conversations
          .getMessages(c.id)
          .filter((m) => m.kind === 'signoff')
          .map((m) => m.authorName)
      )
      for (const p of this.conversations.getParticipants(c.id)) {
        if (signed.has(p.name)) continue
        this.conversations.addMessage({
          conversationId: c.id,
          authorName: p.name,
          content: `Signed off by ${actor}`,
          kind: 'signoff'
        })
      }
      this.conversations.recomputeHeader(c.id)
    }
  }
}
