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
  InboxConflictError
} from './lifecycle/errors'
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
import type { QueueLifecycleService, QueueRuntime } from './lifecycle/queue-lifecycle-service'

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

  // ── Conversation lifecycle (composite) — slice 11 throws ──────────────────
  async openConversation(_input: OpenConversationInput): Promise<Conversation> {
    throw new PostgresNotImplementedError('openConversation')
  }
  async decideConversation(_id: string, _input: DecideConversationInput): Promise<DecideConversationResult> {
    throw new PostgresNotImplementedError('decideConversation')
  }
  async closeConversation(_id: string): Promise<Conversation> {
    throw new PostgresNotImplementedError('closeConversation')
  }
  async reopenConversation(_id: string): Promise<Conversation> {
    throw new PostgresNotImplementedError('reopenConversation')
  }

  // ── Session lifecycle (composite) — slice 11 throws ───────────────────────
  async startSession(_input: StartSessionInput): Promise<StartSessionResult> {
    throw new PostgresNotImplementedError('startSession')
  }
  async endSession(_id: string, _input: EndSessionInput): Promise<EndSessionResult> {
    throw new PostgresNotImplementedError('endSession')
  }
  async abandonSession(_id: string, _reason: string): Promise<AbandonSessionResult> {
    throw new PostgresNotImplementedError('abandonSession')
  }
  async checkpointSession(_id: string, _input: CheckpointSessionInput): Promise<CheckpointSessionResult> {
    throw new PostgresNotImplementedError('checkpointSession')
  }
  async resumeSession(_id: string): Promise<ResumeSessionResult> {
    throw new PostgresNotImplementedError('resumeSession')
  }

  // ── Task review lifecycle (ADR-024) — slice 11 throws ─────────────────────
  async approveTask(_taskId: string, _note?: string): Promise<ApproveTaskResult> {
    throw new PostgresNotImplementedError('approveTask')
  }
  async rejectTask(_taskId: string, _reason: string): Promise<RejectTaskResult> {
    throw new PostgresNotImplementedError('rejectTask')
  }

  // ── Queue lifecycle (ADR-019) — slice 11 throws ───────────────────────────
  createQueueLifecycle(_runtime: QueueRuntime): QueueLifecycleService {
    throw new PostgresNotImplementedError('createQueueLifecycle')
  }

  // ── ac-check (ADR-029 channel 2) — slice 11 throws ────────────────────────
  async checkAcItem(_input: CheckAcItemInput): Promise<CheckAcItemResult> {
    throw new PostgresNotImplementedError('checkAcItem')
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
