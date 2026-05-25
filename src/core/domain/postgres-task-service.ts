// ADR-030 slice 11/N — PostgresTaskService facade.
//
// Aggregates the 16 Postgres-side repositories (shipped in slices 1–10)
// behind the BackendTaskService port. Repo-level operations delegate
// straight to the corresponding `.pg.ts` repo; composite-transaction
// lifecycle services (inbox / conversation / session / task-review),
// the knowledge layer, file-copy backup, and the ac-check composite
// throw PostgresNotImplementedError — they land in follow-up slices.
//
// Construction is synchronous (matches SqliteTaskService). Schema
// migrations run inside `initializeAsync()` — the same hook callers
// (CLI service-factory, MCP server-bootstrap) already await before
// using the service, so no caller signature change is needed.

import type { BackendTaskService } from './backend-task-service.interface'
import { PgConnection } from './repositories/postgres/connection'
import { migrate } from './repositories/postgres/migrations'
import { PostgresProjectRepository } from './repositories/postgres/project-repository.pg'
import { PostgresWorkspaceRepository } from './repositories/postgres/workspace-repository.pg'
import { PostgresTaskRepository } from './repositories/postgres/task-repository.pg'
import { PostgresDocumentRepository } from './repositories/postgres/document-repository.pg'
import { PostgresTagRepository } from './repositories/postgres/tag-repository.pg'
import { PostgresRelationshipRepository } from './repositories/postgres/relationship-repository.pg'
import { PostgresSessionRepository } from './repositories/postgres/session-repository.pg'
import { PostgresContextSourceRepository } from './repositories/postgres/context-source-repository.pg'
import { PostgresConversationRepository } from './repositories/postgres/conversation-repository.pg'
import { PostgresInboxRepository } from './repositories/postgres/inbox-repository.pg'
import { PostgresCounterRepository } from './repositories/postgres/counter-repository.pg'
import { PostgresToolInvocationsRepository } from './repositories/postgres/tool-invocations-repository.pg'
import { PostgresSessionEventRepository } from './repositories/postgres/session-event-repository.pg'
import { PostgresAgentMemoryRepository } from './repositories/postgres/agent-memory-repository.pg'
import { PostgresNotImplementedError } from './postgres-not-implemented-error'
import {
  InboxNotFoundError,
  InboxStatusError,
  InboxConflictError,
  ConversationNotFoundError,
  ConversationStatusError,
  SessionNotFoundError,
  SessionStatusError,
  TaskLockedBySessionError,
  TaskNotFoundError,
  TaskStatusError,
  NoActiveSessionError
} from './lifecycle/errors'
import { ReviewSessionResolutionError } from './lifecycle/task-review-lifecycle-service'
import { now } from './repositories/shared'
import { findAcItems, flipAcCheckbox } from './lifecycle/ac-check'
import type { Queryable } from './repositories/postgres/connection'
import { buildSelfEditPrompt } from './lifecycle/session-lifecycle-service'
import type { DecideConversationResultAction } from './interfaces/conversation-lifecycle.interface'
import type { SessionSummaryPayload } from './interfaces/session-lifecycle.interface'
import type { ProjectRow } from './repositories/project-repository'
import type { WorkspaceRow } from './repositories/workspace-repository'
import type {
  Task,
  CreateTaskInput,
  UpdateTaskInput,
  TaskFilter,
  TaskDependency,
  Document,
  DocumentType,
  CreateDocumentInput,
  UpdateDocumentInput,
  Relationship,
  RelationType,
  Session,
  SessionStatus,
  CreateSessionInput,
  UpdateSessionInput,
  ContextSource,
  CreateContextSourceInput,
  UpdateContextSourceInput,
  Conversation,
  ConversationStatus,
  ConversationMessage,
  ConversationLink,
  ConversationLinkType,
  ConversationParticipant,
  ConversationParticipantType,
  ConversationAction,
  CreateConversationInput,
  UpdateConversationInput,
  CreateConversationMessageInput,
  CreateConversationActionInput,
  UpdateConversationActionInput,
  InboxItem,
  CreateInboxInput,
  UpdateInboxInput,
  InboxFilter,
  CreateSessionEventInput,
  SessionEvent,
  SessionEventType,
  AgentMemory,
  MemoryScopeType
} from './task-types'
import type {
  InboxConvertInput,
  InboxConvertResult,
  InboxResearchResult
} from './interfaces/inbox-lifecycle.interface'
import type {
  OpenConversationInput,
  DecideConversationInput,
  DecideConversationResult
} from './interfaces/conversation-lifecycle.interface'
import type {
  StartSessionInput,
  StartSessionResult,
  EndSessionInput,
  EndSessionResult,
  AbandonSessionResult,
  CheckpointSessionInput,
  CheckpointSessionResult,
  ResumeSessionResult
} from './interfaces/session-lifecycle.interface'
import type {
  ApproveTaskResult,
  RejectTaskResult
} from './interfaces/task-review-lifecycle.interface'
import type {
  CreateKnowledgeInput,
  KnowledgeEntry,
  KnowledgeListFilter,
  KnowledgeListItem,
  KnowledgeSearchResult,
  KnowledgeVerifyResult,
  RegisterExistingKnowledgeInput,
  UpdateKnowledgeInput
} from './knowledge-types'
import type {
  ToolInvocation,
  ToolInvocationAggregate,
  ToolInvocationWindow
} from './interfaces/tool-invocations-repository.interface'
import type { MemoryWriteInput, MemoryRecallInput } from './interfaces/agent-memory-operations.interface'
import type { CheckAcItemInput, CheckAcItemResult } from './lifecycle/ac-check'
import {
  QueueLifecycleService,
  type QueueRuntime,
  type QueueSessionGateway
} from './lifecycle/queue-lifecycle-service'

export class PostgresTaskService implements BackendTaskService {
  private readonly conn: PgConnection
  private readonly projects: PostgresProjectRepository
  private readonly workspaces: PostgresWorkspaceRepository
  private readonly tasks: PostgresTaskRepository
  private readonly documents: PostgresDocumentRepository
  private readonly tagsRepo: PostgresTagRepository
  private readonly relationships: PostgresRelationshipRepository
  private readonly sessions: PostgresSessionRepository
  private readonly contextSources: PostgresContextSourceRepository
  private readonly conversations: PostgresConversationRepository
  private readonly inbox: PostgresInboxRepository
  private readonly counters: PostgresCounterRepository
  private readonly toolInvocations: PostgresToolInvocationsRepository
  private readonly sessionEvents: PostgresSessionEventRepository
  private readonly agentMemories: PostgresAgentMemoryRepository
  private migrationsRanPromise: Promise<void> | null = null

  constructor(conn: PgConnection) {
    this.conn = conn
    this.projects = new PostgresProjectRepository(conn)
    this.workspaces = new PostgresWorkspaceRepository(conn)
    this.relationships = new PostgresRelationshipRepository(conn)
    this.counters = new PostgresCounterRepository(conn)
    this.toolInvocations = new PostgresToolInvocationsRepository(conn)
    this.sessionEvents = new PostgresSessionEventRepository(conn)
    this.agentMemories = new PostgresAgentMemoryRepository(conn)
    this.tasks = new PostgresTaskRepository(conn, this.relationships, this.counters)
    this.documents = new PostgresDocumentRepository(conn)
    this.tagsRepo = new PostgresTagRepository(conn)
    this.sessions = new PostgresSessionRepository(conn)
    this.contextSources = new PostgresContextSourceRepository(conn)
    this.conversations = new PostgresConversationRepository(conn)
    this.inbox = new PostgresInboxRepository(conn, this.counters)
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  async initialize(): Promise<void> {
    /* schema bootstrap deferred to initializeAsync — matches the SQLite
     * lifecycle order (callers always invoke initializeAsync before use). */
  }
  async initializeAsync(): Promise<void> {
    if (this.migrationsRanPromise) return this.migrationsRanPromise
    this.migrationsRanPromise = (async (): Promise<void> => {
      await migrate(this.conn)
    })()
    return this.migrationsRanPromise
  }
  async close(): Promise<void> {
    await this.conn.close()
  }

  async backup(_absolutePath: string): Promise<void> {
    throw new PostgresNotImplementedError(
      'backup — use pg_dump against the connection string instead; in-process backup lands in a follow-up slice'
    )
  }

  // ── Tool invocations (TASK-681) ────────────────────────────────────────────
  async recordToolInvocation(invocation: ToolInvocation): Promise<void> {
    await this.toolInvocations.recordToolInvocation(invocation)
  }
  async countToolInvocations(): Promise<number> {
    return this.toolInvocations.countToolInvocations()
  }
  async queryToolInvocations(window: ToolInvocationWindow): Promise<ToolInvocationAggregate[]> {
    return this.toolInvocations.queryToolInvocations(window)
  }

  // ── Project operations ─────────────────────────────────────────────────────
  async ensureProject(id: string, name: string, cwd: string): Promise<void> {
    await this.projects.ensure(id, name, cwd)
  }
  async getProject(id: string): Promise<ProjectRow | null> {
    return this.projects.get(id)
  }
  async listProjects(): Promise<ProjectRow[]> {
    return this.projects.list()
  }

  // ── Workspace operations ───────────────────────────────────────────────────
  async addWorkspace(projectId: string, id: string, label: string, cwd: string): Promise<WorkspaceRow> {
    return this.workspaces.add(projectId, id, label, cwd)
  }
  async getWorkspace(id: string): Promise<WorkspaceRow | null> {
    return this.workspaces.get(id)
  }
  async findWorkspaces(projectId: string, includeArchived = false): Promise<WorkspaceRow[]> {
    return this.workspaces.findByProject(projectId, includeArchived)
  }
  async archiveWorkspace(id: string): Promise<WorkspaceRow | null> {
    return this.workspaces.archive(id)
  }
  async unarchiveWorkspace(id: string): Promise<WorkspaceRow | null> {
    return this.workspaces.unarchive(id)
  }

  // ── Task operations ────────────────────────────────────────────────────────
  async createTask(input: CreateTaskInput): Promise<Task> {
    return this.tasks.create(input)
  }
  async updateTask(id: string, input: UpdateTaskInput): Promise<Task> {
    return this.tasks.update(id, input)
  }
  async deleteTask(id: string): Promise<void> {
    await this.tasks.delete(id)
  }
  async getTask(id: string): Promise<Task | null> {
    return this.tasks.get(id)
  }
  async findTasks(filter: TaskFilter): Promise<Task[]> {
    return this.tasks.find(filter)
  }
  async getSubtasks(parentId: string): Promise<Task[]> {
    return this.tasks.getSubtasks(parentId)
  }
  async getPinnedTasks(): Promise<Task[]> {
    return this.tasks.getPinned()
  }
  async getDueTasks(date: string): Promise<Task[]> {
    return this.tasks.getDue(date)
  }
  async addDependency(sourceId: string, targetId: string): Promise<void> {
    await this.tasks.addDependency(sourceId, targetId)
  }
  async removeDependency(sourceId: string, targetId: string): Promise<void> {
    await this.tasks.removeDependency(sourceId, targetId)
  }
  async getDependencies(taskId: string): Promise<TaskDependency[]> {
    return this.tasks.getDependencies(taskId)
  }

  // ── Document operations ────────────────────────────────────────────────────
  async createDocument(input: CreateDocumentInput): Promise<Document> {
    return this.documents.create(input)
  }
  async updateDocument(id: string, input: UpdateDocumentInput): Promise<Document> {
    return this.documents.update(id, input)
  }
  async deleteDocument(id: string): Promise<void> {
    await this.documents.delete(id)
  }
  async getDocument(id: string): Promise<Document | null> {
    return this.documents.get(id)
  }
  async findDocuments(projectId: string, type?: DocumentType): Promise<Document[]> {
    return this.documents.findByProject(projectId, type)
  }

  // ── Tags ───────────────────────────────────────────────────────────────────
  async addTag(itemId: string, tag: string): Promise<void> {
    await this.tagsRepo.add(itemId, tag)
  }
  async removeTag(itemId: string, tag: string): Promise<void> {
    await this.tagsRepo.remove(itemId, tag)
  }
  async getTags(itemId: string): Promise<string[]> {
    return this.tagsRepo.getForItem(itemId)
  }
  async findByTag(tag: string): Promise<string[]> {
    return this.tagsRepo.findItemsByTag(tag)
  }

  // ── Relationships ──────────────────────────────────────────────────────────
  async addRelationship(fromId: string, toId: string, type: RelationType): Promise<void> {
    await this.relationships.add(fromId, toId, type)
  }
  async removeRelationship(fromId: string, toId: string, type: RelationType): Promise<void> {
    await this.relationships.remove(fromId, toId, type)
  }
  async getRelationships(itemId: string): Promise<Relationship[]> {
    return this.relationships.getForItem(itemId)
  }
  async getRelationshipsFrom(itemId: string, type?: RelationType): Promise<Relationship[]> {
    return this.relationships.getFrom(itemId, type)
  }

  // ── Session operations (M1) ────────────────────────────────────────────────
  async createSession(input: CreateSessionInput): Promise<Session> {
    return this.sessions.create(input)
  }
  async updateSession(id: string, input: UpdateSessionInput): Promise<Session> {
    return this.sessions.update(id, input)
  }
  async getSession(id: string): Promise<Session | null> {
    return this.sessions.get(id)
  }
  async findSessions(projectId: string, status?: SessionStatus): Promise<Session[]> {
    return this.sessions.findByProject(projectId, status)
  }
  async getActiveSession(projectId: string, workspaceId?: string): Promise<Session | null> {
    return this.sessions.getActive(projectId, workspaceId)
  }
  async deleteSession(id: string): Promise<void> {
    await this.sessions.delete(id)
  }

  // ── Context source operations (M1) ─────────────────────────────────────────
  async createContextSource(input: CreateContextSourceInput): Promise<ContextSource> {
    return this.contextSources.create(input)
  }
  async updateContextSource(id: string, input: UpdateContextSourceInput): Promise<ContextSource> {
    return this.contextSources.update(id, input)
  }
  async getContextSource(id: string): Promise<ContextSource | null> {
    return this.contextSources.get(id)
  }
  async findContextSources(projectId: string, activeOnly = false): Promise<ContextSource[]> {
    return this.contextSources.findByProject(projectId, activeOnly)
  }
  async deleteContextSource(id: string): Promise<void> {
    await this.contextSources.delete(id)
  }

  // ── Conversation operations (M1) ───────────────────────────────────────────
  async createConversation(input: CreateConversationInput): Promise<Conversation> {
    return this.conversations.create(input)
  }
  async updateConversation(id: string, input: UpdateConversationInput): Promise<Conversation> {
    return this.conversations.update(id, input)
  }
  async getConversation(id: string): Promise<Conversation | null> {
    return this.conversations.get(id)
  }
  async findConversations(projectId: string, status?: ConversationStatus): Promise<Conversation[]> {
    return this.conversations.findByProject(projectId, status)
  }
  async deleteConversation(id: string): Promise<void> {
    await this.conversations.delete(id)
  }

  async addConversationParticipant(
    conversationId: string,
    name: string,
    type: ConversationParticipantType,
    role?: string | null
  ): Promise<void> {
    await this.conversations.addParticipant(conversationId, name, type, role)
  }
  async removeConversationParticipant(conversationId: string, name: string): Promise<void> {
    await this.conversations.removeParticipant(conversationId, name)
  }
  async getConversationParticipants(conversationId: string): Promise<ConversationParticipant[]> {
    return this.conversations.getParticipants(conversationId)
  }

  async addConversationMessage(input: CreateConversationMessageInput): Promise<ConversationMessage> {
    return this.conversations.addMessage(input)
  }
  async getConversationMessages(conversationId: string): Promise<ConversationMessage[]> {
    return this.conversations.getMessages(conversationId)
  }

  async addConversationAction(input: CreateConversationActionInput): Promise<ConversationAction> {
    return this.conversations.addAction(input)
  }
  async updateConversationAction(id: string, input: UpdateConversationActionInput): Promise<ConversationAction> {
    return this.conversations.updateAction(id, input)
  }
  async getConversationActions(conversationId: string): Promise<ConversationAction[]> {
    return this.conversations.getActions(conversationId)
  }

  async linkConversation(
    conversationId: string,
    linkedType: ConversationLinkType,
    linkedId: string
  ): Promise<void> {
    await this.conversations.link(conversationId, linkedType, linkedId)
  }
  async unlinkConversation(
    conversationId: string,
    linkedType: ConversationLinkType,
    linkedId: string
  ): Promise<void> {
    await this.conversations.unlink(conversationId, linkedType, linkedId)
  }
  async getConversationLinks(conversationId: string): Promise<ConversationLink[]> {
    return this.conversations.getLinks(conversationId)
  }
  async findConversationsByLink(linkedType: ConversationLinkType, linkedId: string): Promise<Conversation[]> {
    return this.conversations.findByLink(linkedType, linkedId)
  }

  // ── Inbox ──────────────────────────────────────────────────────────────────
  async createInbox(input: CreateInboxInput): Promise<InboxItem> {
    return this.inbox.create(input)
  }
  async updateInbox(id: string, input: UpdateInboxInput): Promise<InboxItem> {
    return this.inbox.update(id, input)
  }
  async getInbox(id: string): Promise<InboxItem | null> {
    return this.inbox.get(id)
  }
  async findInbox(filter: InboxFilter): Promise<InboxItem[]> {
    return this.inbox.find(filter)
  }
  async deleteInbox(id: string): Promise<void> {
    await this.inbox.delete(id)
  }

  // ── Inbox lifecycle (composite, transactional) — slice 15 ─────────────────
  //
  // Each composite opens a single `conn.transaction(async tx => …)` and
  // constructs tx-bound repos inside. The `Queryable` constructor type on
  // every PG repo (slice 15 foundation) is what makes the tx hand-off work
  // without per-repo `withTx` clones. Sub-repos like CounterRepository must
  // also be tx-bound so id-mint participates in the same atomic step.

  async startInboxResearch(id: string, researcher: string): Promise<InboxResearchResult> {
    return this.conn.transaction(async (tx): Promise<InboxResearchResult> => {
      const counters = new PostgresCounterRepository(tx)
      const inbox = new PostgresInboxRepository(tx, counters)
      const conversations = new PostgresConversationRepository(tx)

      const item = await inbox.get(id)
      if (!item) throw new InboxNotFoundError(id)
      if (item.status !== 'raw') {
        throw new InboxStatusError(id, item.status, 'cannot start research (must be raw)')
      }
      const existing = await conversations.findByLink('inbox', id)
      if (existing.length > 0) {
        throw new InboxConflictError(id, `already has conversation ${existing[0].id}`)
      }
      const projectId = item.projectId ?? 'global'
      const conv = await conversations.create({
        projectId,
        title: `Research: ${item.content.slice(0, 80)}`,
        createdBy: researcher,
        status: 'open',
        participants: [
          { name: 'Butter', type: 'human' },
          { name: researcher, type: 'agent' }
        ]
      })
      await conversations.link(conv.id, 'inbox', id)
      await inbox.update(id, { status: 'researching' })
      return { inboxId: id, conversationId: conv.id, status: 'researching' }
    })
  }

  async convertInboxToTask(id: string, input: InboxConvertInput): Promise<InboxConvertResult> {
    return this.conn.transaction(async (tx): Promise<InboxConvertResult> => {
      const counters = new PostgresCounterRepository(tx)
      const inbox = new PostgresInboxRepository(tx, counters)
      const conversations = new PostgresConversationRepository(tx)
      const relationships = new PostgresRelationshipRepository(tx)
      const tasks = new PostgresTaskRepository(tx, relationships, counters)

      const item = await inbox.get(id)
      if (!item) throw new InboxNotFoundError(id)
      if (item.status === 'converted' || item.status === 'archived') {
        throw new InboxStatusError(id, item.status, 'cannot convert')
      }
      if (!item.projectId) {
        throw new InboxConflictError(id, 'no projectId — assign one before converting')
      }
      const task = await tasks.create({
        projectId: item.projectId,
        title: input.title,
        priority: input.priority,
        labels: input.labels,
        status: 'TODO'
      })
      if (input.body) await tasks.update(task.id, { body: input.body })
      await inbox.update(id, { status: 'converted', linkedTaskId: task.id })
      await this.closeLinkedConversations(
        conversations,
        id,
        `Converted to ${task.id}: ${input.title}`
      )
      const final = await tasks.get(task.id)
      if (!final) throw new Error(`Task ${task.id} disappeared mid-transaction`)
      return { inboxId: id, taskId: task.id, task: final }
    })
  }

  async archiveInbox(id: string, reason?: string): Promise<InboxItem> {
    return this.conn.transaction(async (tx): Promise<InboxItem> => {
      const counters = new PostgresCounterRepository(tx)
      const inbox = new PostgresInboxRepository(tx, counters)
      const conversations = new PostgresConversationRepository(tx)

      const item = await inbox.get(id)
      if (!item) throw new InboxNotFoundError(id)
      if (item.status === 'converted') {
        throw new InboxStatusError(id, item.status, 'already converted — cannot archive')
      }
      await inbox.update(id, { status: 'archived' })
      await this.closeLinkedConversations(
        conversations,
        id,
        reason ? `Archived: ${reason}` : 'Archived'
      )
      const final = await inbox.get(id)
      if (!final) throw new Error(`Inbox ${id} disappeared mid-transaction`)
      return final
    })
  }

  private async closeLinkedConversations(
    conversations: PostgresConversationRepository,
    inboxId: string,
    decisionSummary: string
  ): Promise<void> {
    const convs = await conversations.findByLink('inbox', inboxId)
    if (convs.length === 0) return
    const closedAt = new Date().toISOString()
    for (const c of convs) {
      if (c.status !== 'closed') {
        await conversations.update(c.id, { status: 'closed', decisionSummary, closedAt })
      }
    }
  }

  // ── Conversation lifecycle (composite) — slice 16 ─────────────────────────
  async openConversation(input: OpenConversationInput): Promise<Conversation> {
    return this.conn.transaction(async (tx): Promise<Conversation> => {
      const conversations = new PostgresConversationRepository(tx)
      const sessions = new PostgresSessionRepository(tx)

      const resolvedSessionId = await this.resolveOpenSessionId(
        sessions,
        input.projectId,
        input.sessionId
      )

      const conv = await conversations.create({
        projectId: input.projectId,
        title: input.title,
        createdBy: input.createdBy,
        participants: input.participants,
        ownerType: 'interactive',
        ownerSessionId: resolvedSessionId ?? undefined
      })

      await conversations.emitLifecycleEvent(
        conv.id,
        'conversation.open',
        input.createdBy,
        conv.createdAt
      )

      await conversations.addMessage({
        conversationId: conv.id,
        authorName: input.createdBy,
        content: input.initialMessage.content,
        messageType: input.initialMessage.type
      })

      for (const taskId of input.linkedTasks ?? []) {
        await conversations.link(conv.id, 'task', taskId)
      }

      if (resolvedSessionId) {
        await conversations.link(conv.id, 'session', resolvedSessionId)
      }

      const final = await conversations.get(conv.id)
      if (!final) throw new Error(`Conversation ${conv.id} disappeared mid-transaction`)
      return final
    })
  }

  private async resolveOpenSessionId(
    sessions: PostgresSessionRepository,
    projectId: string,
    explicit: string | undefined
  ): Promise<string | null> {
    if (explicit !== undefined) {
      const session = await sessions.get(explicit)
      if (!session) throw new Error(`Session ${explicit} not found`)
      if (session.status !== 'active') throw new Error(`Session ${explicit} is not active`)
      if (session.projectId !== projectId) {
        throw new Error(
          `Session ${explicit} belongs to project ${session.projectId}, not ${projectId}`
        )
      }
      return explicit
    }

    const active = await sessions.findByProject(projectId, 'active')
    if (active.length === 1) return active[0].id
    if (active.length > 1) {
      console.warn(
        `[PostgresConversationLifecycle] ${active.length} active sessions in project ${projectId} — skipping auto-link`
      )
    }
    return null
  }

  async decideConversation(
    id: string,
    input: DecideConversationInput
  ): Promise<DecideConversationResult> {
    return this.conn.transaction(async (tx): Promise<DecideConversationResult> => {
      const counters = new PostgresCounterRepository(tx)
      const relationships = new PostgresRelationshipRepository(tx)
      const conversations = new PostgresConversationRepository(tx)
      const tasks = new PostgresTaskRepository(tx, relationships, counters)

      const conv = await conversations.get(id)
      if (!conv) throw new ConversationNotFoundError(id)

      await conversations.addMessage({
        conversationId: id,
        authorName: input.author,
        content: input.decision,
        messageType: 'decision'
      })

      const decidedAt = now()
      const updated = await conversations.update(id, {
        status: 'decided',
        decisionSummary: input.decision,
        decidedAt
      })

      const actions: DecideConversationResultAction[] = []
      for (const action of input.actions ?? []) {
        let linkedTaskId: string | undefined
        if (action.spawnTask) {
          const task = await tasks.create({
            projectId: conv.projectId,
            title: action.spawnTask.title,
            priority: action.spawnTask.priority,
            labels: [`assignee:${action.assignee}`]
          })
          linkedTaskId = task.id
          await conversations.link(id, 'task', task.id)
        }
        const created = await conversations.addAction({
          conversationId: id,
          assignee: action.assignee,
          description: action.description,
          linkedTaskId
        })
        actions.push({
          id: created.id,
          assignee: created.assignee,
          description: created.description,
          linkedTaskId: created.linkedTaskId
        })
      }

      await conversations.emitLifecycleEvent(id, 'conversation.decide', input.author, decidedAt)
      return { conversation: updated, actions }
    })
  }

  async closeConversation(id: string): Promise<Conversation> {
    return this.conn.transaction(async (tx): Promise<Conversation> => {
      const conversations = new PostgresConversationRepository(tx)
      const conv = await conversations.get(id)
      if (!conv) throw new ConversationNotFoundError(id)
      if (conv.status !== 'decided') {
        throw new ConversationStatusError(id, conv.status, 'must be decided before closing')
      }
      const closedAt = now()
      const updated = await conversations.update(id, { status: 'closed', closedAt })
      await conversations.emitLifecycleEvent(id, 'conversation.close', 'system', closedAt)
      return updated
    })
  }

  async reopenConversation(id: string): Promise<Conversation> {
    return this.conn.transaction(async (tx): Promise<Conversation> => {
      const conversations = new PostgresConversationRepository(tx)
      const conv = await conversations.get(id)
      if (!conv) throw new ConversationNotFoundError(id)
      if (conv.status !== 'decided' && conv.status !== 'closed') {
        throw new ConversationStatusError(
          id,
          conv.status,
          'only decided or closed conversations can reopen'
        )
      }
      const updated = await conversations.update(id, {
        status: 'discussing',
        closedAt: null,
        decidedAt: null,
        decisionSummary: null
      })
      await conversations.emitLifecycleEvent(id, 'conversation.reopen', 'system', now())
      return updated
    })
  }

  // ── Session lifecycle (composite) — slice 17 ──────────────────────────────
  async startSession(input: StartSessionInput): Promise<StartSessionResult> {
    return this.conn.transaction(async (tx): Promise<StartSessionResult> => {
      const counters = new PostgresCounterRepository(tx)
      const relationships = new PostgresRelationshipRepository(tx)
      const sessions = new PostgresSessionRepository(tx)
      const tasks = new PostgresTaskRepository(tx, relationships, counters)
      const contextSources = new PostgresContextSourceRepository(tx)

      const existingActiveSessions = await sessions.findByProject(input.projectId, 'active')

      if (input.taskId) {
        const task = await tasks.get(input.taskId)
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

      const session = await sessions.create({
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        taskId: input.taskId,
        startedAt: now(),
        status: 'active'
      })

      if (input.taskId) {
        await tasks.update(input.taskId, { status: 'IN-PROGRESS' })
      }

      const activeContextSources = await contextSources.findByProject(input.projectId, true)

      // recallMemories is a pure read — safe outside the tx, called via this.* on the
      // pool-bound repos. Mirrors the sqlite side which calls recallMemoriesSync inside tx
      // but it's read-only so isolation level doesn't matter.
      const recalledMemories = await this.recallMemories({
        taskId: input.taskId,
        workspaceId: input.workspaceId,
        projectId: input.projectId
      })

      return {
        session,
        contextSources: activeContextSources,
        existingActiveSessions,
        recalledMemories
      }
    })
  }

  async endSession(id: string, input: EndSessionInput): Promise<EndSessionResult> {
    return this.conn.transaction((tx) => this.endSessionInTx(tx, id, input))
  }

  // Tx-bound body of endSession — extracted so approveTask/rejectTask (slice 18)
  // can compose it inside their own outer transaction. The pattern mirrors the
  // sqlite side's endSessionSync, which exists for the same reason (better-sqlite3
  // doesn't allow async transactions, so the composing call must reuse the same
  // sync tx callback).
  private async endSessionInTx(
    tx: Queryable,
    id: string,
    input: EndSessionInput
  ): Promise<EndSessionResult> {
    const counters = new PostgresCounterRepository(tx)
    const relationships = new PostgresRelationshipRepository(tx)
    const sessions = new PostgresSessionRepository(tx)
    const tasks = new PostgresTaskRepository(tx, relationships, counters)
    const conversations = new PostgresConversationRepository(tx)
    const sessionEvents = new PostgresSessionEventRepository(tx)

    const session = await sessions.get(id)
    if (!session) throw new SessionNotFoundError(id)
    if (session.status !== 'active') {
      throw new SessionStatusError(id, session.status, 'only active sessions can end')
    }

    const endedAt = now()
    const decisionSummary =
      input.decisionSummary ?? input.handoff.resumePoint ?? 'Session ended'

    const closedConversationIds: string[] = []
    const linkedConvs = await conversations.findByLink('session', id)
    for (const conv of linkedConvs) {
      if (conv.status === 'closed') continue
      await conversations.update(conv.id, {
        status: 'closed',
        decisionSummary,
        closedAt: endedAt
      })
      closedConversationIds.push(conv.id)
    }

    let taskUpdated: EndSessionResult['taskUpdated'] = null
    if (session.taskId) {
      const task = await tasks.get(session.taskId)
      if (task) {
        await tasks.update(session.taskId, { status: 'DONE' })
        taskUpdated = { id: task.id, title: task.title, newStatus: 'DONE' }
      }
    }

    const updated = await sessions.update(id, {
      status: 'completed',
      endedAt,
      handoff: input.handoff
    })

    if (input.summary) {
      const merged = await aggregateSessionSummaryAsync(sessionEvents, tasks, id, input.summary)
      await sessionEvents.create({
        sessionId: id,
        eventType: 'observation',
        payloadJson: JSON.stringify({ kind: 'session_summary', ...merged }),
        memoryCandidate: false
      })
    }

    const memoryCandidates = await sessionEvents.listMemoryCandidates(id)
    const selfEditPrompt = buildSelfEditPrompt(memoryCandidates)

    return {
      session: updated,
      closedConversationIds,
      taskUpdated,
      memoryCandidates,
      selfEditPrompt
    }
  }

  async abandonSession(id: string, reason: string): Promise<AbandonSessionResult> {
    return this.conn.transaction(async (tx): Promise<AbandonSessionResult> => {
      const sessions = new PostgresSessionRepository(tx)
      const conversations = new PostgresConversationRepository(tx)

      const session = await sessions.get(id)
      if (!session) throw new SessionNotFoundError(id)
      if (session.status !== 'active') {
        throw new SessionStatusError(id, session.status, 'only active sessions can be abandoned')
      }

      const endedAt = now()
      const decisionSummary = `Abandoned: ${reason}`

      const closedConversationIds: string[] = []
      const linkedConvs = await conversations.findByLink('session', id)
      for (const conv of linkedConvs) {
        if (conv.status === 'closed') continue
        await conversations.update(conv.id, {
          status: 'closed',
          decisionSummary,
          closedAt: endedAt
        })
        closedConversationIds.push(conv.id)
      }

      // Intentionally do NOT touch session.taskId — task stays IN-PROGRESS for human review.
      const handoff = { ...(session.handoff ?? {}), failureReason: reason }
      const updated = await sessions.update(id, {
        status: 'completed',
        endedAt,
        handoff
      })

      return { session: updated, closedConversationIds }
    })
  }

  async checkpointSession(
    id: string,
    input: CheckpointSessionInput
  ): Promise<CheckpointSessionResult> {
    // Pure single-row update; no need for an outer tx. Matches sqlite shape.
    const session = await this.sessions.get(id)
    if (!session) throw new SessionNotFoundError(id)
    if (session.status !== 'active') {
      throw new SessionStatusError(id, session.status, 'only active sessions can checkpoint')
    }

    const updated = await this.sessions.update(id, {
      checkpoint: input.checkpoint,
      checkpointAt: now()
    })
    return { session: updated }
  }

  async resumeSession(id: string): Promise<ResumeSessionResult> {
    // Three reads, no mutations. Sqlite doesn't wrap this in a tx either.
    const session = await this.sessions.get(id)
    if (!session) throw new SessionNotFoundError(id)

    const conversations = await this.conversations.findByLink('session', id)
    const contextSources = await this.contextSources.findByProject(session.projectId, true)

    return {
      session,
      checkpoint: session.checkpoint,
      conversations,
      contextSources
    }
  }

  // ── Task review lifecycle (ADR-024) — slice 18 ────────────────────────────
  async approveTask(taskId: string, note?: string): Promise<ApproveTaskResult> {
    return this.conn.transaction(async (tx): Promise<ApproveTaskResult> => {
      const counters = new PostgresCounterRepository(tx)
      const relationships = new PostgresRelationshipRepository(tx)
      const tasks = new PostgresTaskRepository(tx, relationships, counters)
      const sessions = new PostgresSessionRepository(tx)

      const sessionId = await this.guardAndResolveReviewSession(tx, taskId, sessions, tasks, 'approve')
      const handoff = {
        reviewOutcome: 'approved' as const,
        resumePoint: note ? `Approved: ${note}` : 'Approved after review',
        ...(note ? { decisions: [`Approved: ${note}`] } : {})
      }
      const endResult = await this.endSessionInTx(tx, sessionId, { handoff })
      // endSession sets task → DONE when session has taskId; re-apply explicitly so
      // the composite's final state is self-documenting and won't drift if endSession
      // changes. Mirrors the sqlite side.
      await tasks.update(taskId, { status: 'DONE' })
      return {
        taskId,
        status: 'DONE',
        sessionId,
        memoryCandidates: endResult.memoryCandidates,
        selfEditPrompt: endResult.selfEditPrompt
      }
    })
  }

  async rejectTask(taskId: string, reason: string): Promise<RejectTaskResult> {
    return this.conn.transaction(async (tx): Promise<RejectTaskResult> => {
      const counters = new PostgresCounterRepository(tx)
      const relationships = new PostgresRelationshipRepository(tx)
      const tasks = new PostgresTaskRepository(tx, relationships, counters)
      const sessions = new PostgresSessionRepository(tx)

      const sessionId = await this.guardAndResolveReviewSession(tx, taskId, sessions, tasks, 'reject')
      const handoff = {
        reviewOutcome: 'rejected' as const,
        reviewReason: reason,
        resumePoint: `Rejected: ${reason}`,
        decisions: [`Rejected: ${reason}`]
      }
      const endResult = await this.endSessionInTx(tx, sessionId, { handoff })
      // endSession unconditionally sets task → DONE; override to IN-PROGRESS within
      // the same outer tx so the task lands back in the work queue.
      await tasks.update(taskId, { status: 'IN-PROGRESS' })
      return {
        taskId,
        status: 'IN-PROGRESS',
        sessionId,
        memoryCandidates: endResult.memoryCandidates,
        selfEditPrompt: endResult.selfEditPrompt
      }
    })
  }

  private async guardAndResolveReviewSession(
    _tx: Queryable,
    taskId: string,
    sessions: PostgresSessionRepository,
    tasks: PostgresTaskRepository,
    op: 'approve' | 'reject'
  ): Promise<string> {
    const task = await tasks.get(taskId)
    if (!task) throw new TaskNotFoundError(taskId)
    if (task.status !== 'REVIEW') {
      throw new TaskStatusError(taskId, task.status, `not in REVIEW — cannot ${op}`)
    }
    const actives = await sessions.findByProject(task.projectId, 'active')
    const bound = actives.filter((s) => s.taskId === taskId)
    if (bound.length === 0) {
      throw new ReviewSessionResolutionError(taskId, 'no active session bound to task')
    }
    if (bound.length > 1) {
      throw new ReviewSessionResolutionError(
        taskId,
        `${bound.length} active sessions bound to task — race detected`
      )
    }
    return bound[0].id
  }

  // ── Queue lifecycle (ADR-019) — slice 19 ──────────────────────────────────
  /* QueueLifecycleService takes a `SessionLifecycleService` as its 4th arg in
   * the sqlite path. Postgres does not expose a standalone session-lifecycle
   * instance — start/checkpoint/abandon are facade methods. The narrow
   * `QueueSessionGateway` port (start + checkpoint only) lets us hand back a
   * thin adapter without leaking the full lifecycle service. */
  createQueueLifecycle(runtime: QueueRuntime): QueueLifecycleService {
    const sessionGateway: QueueSessionGateway = {
      startSession: (input) => this.startSession(input),
      checkpointSession: (id, input) => this.checkpointSession(id, input)
    }
    return new QueueLifecycleService(
      this.tasks,
      this.workspaces,
      this.conversations,
      sessionGateway,
      runtime
    )
  }

  // ── ac-check (ADR-029 channel 2) — slice 18 ───────────────────────────────
  // Narrow body-lock bypass: flip one AC checkbox + emit an ac_check observation
  // event in a single transaction. Mirrors SqliteTaskService.checkAcItem.
  async checkAcItem(input: CheckAcItemInput): Promise<CheckAcItemResult> {
    // Pre-tx reads + pure helper. The task body diff is computed before the tx
    // opens so that failures (TaskNotFoundError, AcAlreadyCheckedError) don't
    // even start a transaction.
    const task = await this.tasks.get(input.taskId)
    if (!task) throw new TaskNotFoundError(input.taskId)
    const { newBody, item } = flipAcCheckbox(task.body ?? '', task.id, input.acIndex)

    const session = await this.sessions.getActive(task.projectId, input.workspaceId)
    if (!session) throw new NoActiveSessionError(task.projectId, input.workspaceId ?? null)

    return this.conn.transaction(async (tx): Promise<CheckAcItemResult> => {
      const counters = new PostgresCounterRepository(tx)
      const relationships = new PostgresRelationshipRepository(tx)
      const tasks = new PostgresTaskRepository(tx, relationships, counters)
      const sessionEvents = new PostgresSessionEventRepository(tx)

      await tasks.update(task.id, { body: newBody })
      const event = await sessionEvents.create({
        sessionId: session.id,
        eventType: 'observation',
        payloadJson: JSON.stringify({
          kind: 'ac_check',
          taskId: task.id,
          acIndex: input.acIndex,
          text: item.text,
          evidence: input.evidence,
          sessionId: session.id
        }),
        memoryCandidate: false
      })
      return {
        taskId: task.id,
        acIndex: input.acIndex,
        text: item.text,
        evidence: input.evidence,
        eventId: event.id,
        sessionId: session.id
      }
    })
  }

  // ── Knowledge — slice 11 throws (needs pgvector embedding store) ──────────
  async createKnowledge(_input: CreateKnowledgeInput): Promise<KnowledgeEntry> {
    throw new PostgresNotImplementedError('createKnowledge')
  }
  async registerExistingKnowledge(_input: RegisterExistingKnowledgeInput): Promise<KnowledgeEntry> {
    throw new PostgresNotImplementedError('registerExistingKnowledge')
  }
  async getKnowledge(_slug: string): Promise<KnowledgeEntry | null> {
    throw new PostgresNotImplementedError('getKnowledge')
  }
  async listKnowledge(_filter?: KnowledgeListFilter): Promise<KnowledgeListItem[]> {
    throw new PostgresNotImplementedError('listKnowledge')
  }
  async updateKnowledge(_input: UpdateKnowledgeInput): Promise<KnowledgeEntry> {
    throw new PostgresNotImplementedError('updateKnowledge')
  }
  async verifyKnowledge(_slug: string): Promise<KnowledgeVerifyResult> {
    throw new PostgresNotImplementedError('verifyKnowledge')
  }
  async deleteKnowledge(_slug: string): Promise<{ slug: string; deletedFile: boolean }> {
    throw new PostgresNotImplementedError('deleteKnowledge')
  }
  async searchKnowledge(_query: string, _k?: number): Promise<KnowledgeSearchResult> {
    throw new PostgresNotImplementedError('searchKnowledge')
  }

  // ── Session events ─────────────────────────────────────────────────────────
  async createSessionEvent(input: CreateSessionEventInput): Promise<SessionEvent> {
    return this.sessionEvents.create(input)
  }
  async listSessionEvents(
    sessionId: string,
    eventType?: SessionEventType,
    limit?: number
  ): Promise<SessionEvent[]> {
    const all = await this.sessionEvents.listBySession(sessionId, eventType)
    return limit !== undefined ? all.slice(0, limit) : all
  }

  // ── Agent memories ─────────────────────────────────────────────────────────
  async writeMemory(input: MemoryWriteInput): Promise<AgentMemory> {
    return this.agentMemories.create(input)
  }

  // recallMemories is a pure read — implementing here (no transaction needed).
  // Mirrors SqliteTaskService.recallMemoriesSync: fan out by scope, dedupe,
  // sort by importance+recallCount, slice, then bump recall stats.
  async recallMemories(input: MemoryRecallInput): Promise<AgentMemory[]> {
    const { taskId, workspaceId, projectId, userId, tags, limit } = input
    const seen = new Set<string>()
    const merged: AgentMemory[] = []

    const collect = async (scopeType: MemoryScopeType, scopeId: string): Promise<void> => {
      const rows = await this.agentMemories.recall({ scopeType, scopeId, tags, limit })
      for (const row of rows) {
        if (!seen.has(row.id)) {
          seen.add(row.id)
          merged.push(row)
        }
      }
    }

    if (taskId) await collect('task', taskId)
    if (workspaceId) await collect('workspace', workspaceId)
    if (projectId) await collect('project', projectId)
    if (userId) await collect('user', userId)

    merged.sort((a, b) => b.importance - a.importance || b.recallCount - a.recallCount)

    const result = limit !== undefined ? merged.slice(0, limit) : merged
    for (const m of result) {
      await this.agentMemories.updateRecallStats(m.id)
    }
    return result
  }

  async markMemoryPromoted(memoryId: string, adrSlug: string): Promise<void> {
    await this.agentMemories.promoteMarkPromoted(memoryId, adrSlug)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Async sibling of lifecycle/session-lifecycle-service.ts#aggregateSessionSummary.
// Same shape, same merge rule (AI input wins, autoderived fills gaps), but
// awaits the pg repos. Designed to run inside the same `conn.transaction(...)`
// as the `session_summary` INSERT so a SELECT failure mid-aggregate rolls back
// the whole end-session payload.
// ─────────────────────────────────────────────────────────────────────────────

function parseObservationPayload(json: string | null): Record<string, unknown> | null {
  if (!json) return null
  try {
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>
  } catch {
    /* malformed payload — skip */
  }
  return null
}

async function aggregateSessionSummaryAsync(
  sessionEvents: PostgresSessionEventRepository,
  tasks: PostgresTaskRepository,
  sessionId: string,
  summary: SessionSummaryPayload
): Promise<SessionSummaryPayload> {
  const events = await sessionEvents.listBySession(sessionId, 'observation')

  const fileStatsByPath = new Map<string, { added: number; removed: number }>()
  const acEvidencesByTask = new Map<string, string[]>()

  for (const evt of events) {
    const payload = parseObservationPayload(evt.payloadJson)
    if (!payload) continue
    if (payload.kind === 'file_modified' && typeof payload.path === 'string') {
      const prev = fileStatsByPath.get(payload.path) ?? { added: 0, removed: 0 }
      prev.added += typeof payload.linesAdded === 'number' ? payload.linesAdded : 0
      prev.removed += typeof payload.linesRemoved === 'number' ? payload.linesRemoved : 0
      fileStatsByPath.set(payload.path, prev)
    } else if (payload.kind === 'ac_check' && typeof payload.taskId === 'string') {
      const list = acEvidencesByTask.get(payload.taskId) ?? []
      list.push(typeof payload.evidence === 'string' ? payload.evidence : '')
      acEvidencesByTask.set(payload.taskId, list)
    }
  }

  const aiFiles = summary.filesChanged ?? []
  const aiPaths = new Set<string>()
  for (const entry of aiFiles) {
    const split = entry.indexOf(' (')
    aiPaths.add(split >= 0 ? entry.slice(0, split) : entry)
  }
  const derivedFiles: string[] = []
  for (const [p, stats] of fileStatsByPath) {
    if (aiPaths.has(p)) continue
    derivedFiles.push(`${p} (+${stats.added}, -${stats.removed})`)
  }
  const mergedFilesChanged = [...aiFiles, ...derivedFiles]

  const aiAcCoverage = summary.acCoverage ?? {}
  const mergedAcCoverage: Record<string, string> = { ...aiAcCoverage }
  for (const [taskId, evidences] of acEvidencesByTask) {
    const n = evidences.length
    const evidenceSummary = evidences.filter((e) => e.length > 0).join('; ')
    const task = await tasks.get(taskId)
    const m = task ? findAcItems(task.body ?? '').length : n
    if (aiAcCoverage[taskId]) {
      mergedAcCoverage[taskId] = `${aiAcCoverage[taskId]} + ${n} auto-detected`
    } else {
      mergedAcCoverage[taskId] = `${n}/${m} verified (${evidenceSummary})`
    }
  }

  return {
    ...summary,
    filesChanged: mergedFilesChanged,
    acCoverage: mergedAcCoverage
  }
}
