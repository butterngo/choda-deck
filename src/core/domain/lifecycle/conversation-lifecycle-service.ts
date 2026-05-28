import type Database from 'better-sqlite3'
import type { ConversationRepository } from '../repositories/conversation-repository'
import type { TaskRepository } from '../repositories/task-repository'
import type { SessionRepository } from '../repositories/session-repository'
import type {
  ConversationLifecycleOperations,
  OpenConversationInput,
  DecideConversationInput,
  DecideConversationResult,
  DecideConversationResultAction,
  SignoffConversationResult
} from '../interfaces/conversation-lifecycle.interface'
import type { Conversation } from '../task-types'
import { now } from '../repositories/shared'
import { ConversationNotFoundError } from './errors'

export class ConversationLifecycleService implements ConversationLifecycleOperations {
  constructor(
    private readonly db: Database.Database,
    private readonly conversations: ConversationRepository,
    private readonly tasks: TaskRepository,
    private readonly sessions: SessionRepository
  ) {}

  async openConversation(input: OpenConversationInput): Promise<Conversation> {
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
        content: input.initialMessage.content
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

  async decideConversation(id: string, input: DecideConversationInput): Promise<DecideConversationResult> {
    const tx = this.db.transaction((): DecideConversationResult => {
      const conv = this.conversations.get(id)
      if (!conv) throw new ConversationNotFoundError(id)

      this.conversations.addMessage({
        conversationId: id,
        authorName: input.author,
        content: input.decision
      })

      // Record the decision summary but only flip status to `decided` once every
      // participant has signed off (consensus). For solo conversations (or those
      // without registered participants) decideConversation flips immediately.
      const participants = this.conversations.getParticipants(id)
      const everyoneSignedOff =
        participants.length === 0 ||
        participants.every((p) => conv.signedOff.includes(p.name))

      const updated = this.conversations.update(id, {
        decisionSummary: input.decision,
        ...(everyoneSignedOff
          ? { status: 'decided' as const, decidedAt: now() }
          : {})
      })

      const actions: DecideConversationResultAction[] = (input.actions ?? []).map((action) =>
        this.createActionAndMaybeSpawnTask(conv.projectId, id, action)
      )

      return { conversation: updated, actions }
    })
    return tx()
  }

  async signoffConversation(id: string, name: string): Promise<SignoffConversationResult> {
    const tx = this.db.transaction((): SignoffConversationResult => {
      const conv = this.conversations.get(id)
      if (!conv) throw new ConversationNotFoundError(id)

      const signedOff = this.conversations.appendSignoff(id, name)
      const participants = this.conversations.getParticipants(id)
      const everyoneSignedOff =
        participants.length > 0 && participants.every((p) => signedOff.includes(p.name))

      // Flip to decided only when:
      //  1. consensus is reached, AND
      //  2. a decision summary already exists (decideConversation was called)
      let updated = conv
      let decided = false
      if (everyoneSignedOff && conv.decisionSummary && conv.status !== 'decided') {
        updated = this.conversations.update(id, { status: 'decided', decidedAt: now() })
        decided = true
      } else {
        // refresh so the returned conv reflects the new signedOff[]
        updated = this.conversations.get(id) ?? conv
      }
      return { conversation: updated, signedOff, decided }
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
