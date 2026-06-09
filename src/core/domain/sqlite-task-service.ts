import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import type { TaskService } from './task-service.interface'
import { EmbeddingStore } from './embedding/embedding-store'
import { loadEmbeddingProvider } from './embedding/embedding-provider-factory'
import type { EmbeddingProvider } from './embedding/embedding-provider.interface'
import type { SessionOperations } from './interfaces/session-repository.interface'
import type { ContextSourceOperations } from './interfaces/context-source-repository.interface'
import type { ConversationOperations } from './interfaces/conversation-repository.interface'
import type { InboxOperations } from './interfaces/inbox-repository.interface'
import type { ProjectOperations } from './interfaces/project-repository.interface'
import type { WorkspaceOperations } from './interfaces/workspace-repository.interface'
import type {
  InboxLifecycleOperations,
  InboxConvertInput,
  InboxConvertResult,
  InboxResearchResult
} from './interfaces/inbox-lifecycle.interface'
import type {
  ConversationLifecycleOperations,
  OpenConversationInput,
  DecideConversationInput,
  DecideConversationResult,
  SignoffConversationResult
} from './interfaces/conversation-lifecycle.interface'
import type {
  SessionLifecycleOperations,
  StartSessionInput,
  StartSessionResult,
  EndSessionInput,
  EndSessionResult,
  AbandonSessionResult,
  CheckpointSessionInput,
  CheckpointSessionResult,
  ResumeSessionResult
} from './interfaces/session-lifecycle.interface'
import { InboxLifecycleService } from './lifecycle/inbox-lifecycle-service'
import { ConversationLifecycleService } from './lifecycle/conversation-lifecycle-service'
import { SessionLifecycleService } from './lifecycle/session-lifecycle-service'
import { InvestigationLifecycleService } from './lifecycle/investigation-lifecycle-service'
import { InvestigationRepository } from './repositories/investigation-repository'
import type { InvestigationOperations } from './interfaces/investigation.interface'
import type {
  AddEvidenceInput,
  Evidence,
  Hypothesis,
  HypothesisStatus,
  Investigation,
  ResolveInvestigationInput,
  ResolveInvestigationResult,
  StartInvestigationInput
} from './investigation-types'
import { flipAcCheckbox, type CheckAcItemInput, type CheckAcItemResult } from './lifecycle/ac-check'
import { NoActiveSessionError, TaskNotFoundError } from './lifecycle/errors'
import { KnowledgeService } from './knowledge-service'
import { KnowledgeRepository } from './repositories/knowledge-repository'
import { CodeRefRepository } from './repositories/code-ref-repository'
import type { KnowledgeOperations } from './interfaces/knowledge-operations.interface'
import type {
  CodeRefPrefixFilter,
  CodeRefRow,
  TouchesEdge,
  TouchesRelation,
  UpsertCodeRefInput
} from './code-ref-types'
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
  ConversationAction,
  CreateConversationInput,
  UpdateConversationInput,
  CreateConversationMessageInput,
  CreateConversationActionInput,
  UpdateConversationActionInput,
  InboxItem,
  CreateInboxInput,
  UpdateInboxInput,
  InboxFilter
} from './task-types'

import { initSchema } from './repositories/schema'
import { ProjectRepository } from './repositories/project-repository'
import type { ProjectRow } from './repositories/project-repository'
import { WorkspaceRepository } from './repositories/workspace-repository'
import type { WorkspaceRow } from './repositories/workspace-repository'
import { TaskRepository } from './repositories/task-repository'
import { DocumentRepository } from './repositories/document-repository'
import { TagRepository } from './repositories/tag-repository'
import { RelationshipRepository } from './repositories/relationship-repository'
import { SessionRepository } from './repositories/session-repository'
import { ContextSourceRepository } from './repositories/context-source-repository'
import { ConversationRepository } from './repositories/conversation-repository'
import { InboxRepository } from './repositories/inbox-repository'
import { CounterRepository } from './repositories/counter-repository'
import { ToolInvocationsRepository } from './repositories/tool-invocations-repository'
import { SessionEventRepository } from './repositories/session-event-repository'
import { AgentMemoryRepository } from './repositories/agent-memory-repository'
import type {
  ToolInvocation,
  ToolInvocationAggregate,
  ToolInvocationWindow
} from './interfaces/tool-invocations-repository.interface'
import type { SessionEventOperations } from './interfaces/session-event-operations.interface'
import type { AgentMemoryOperations, MemoryWriteInput, MemoryRecallInput } from './interfaces/agent-memory-operations.interface'

export class SqliteTaskService
  implements
    TaskService,
    ProjectOperations,
    WorkspaceOperations,
    SessionOperations,
    ContextSourceOperations,
    ConversationOperations,
    InboxOperations,
    InboxLifecycleOperations,
    ConversationLifecycleOperations,
    SessionLifecycleOperations,
    KnowledgeOperations,
    SessionEventOperations,
    AgentMemoryOperations,
    InvestigationOperations
{
  private readonly db: Database.Database
  private readonly projects: ProjectRepository
  private readonly workspaces: WorkspaceRepository
  private readonly tasks: TaskRepository
  private readonly documents: DocumentRepository
  private readonly tagsRepo: TagRepository
  private readonly relationships: RelationshipRepository
  private readonly sessions: SessionRepository
  private readonly contextSources: ContextSourceRepository
  private readonly conversations: ConversationRepository
  private readonly inbox: InboxRepository
  private readonly counters: CounterRepository
  private readonly toolInvocations: ToolInvocationsRepository
  private readonly sessionEvents: SessionEventRepository
  private readonly agentMemories: AgentMemoryRepository
  private readonly investigations: InvestigationRepository
  private readonly inboxLifecycle: InboxLifecycleService
  private readonly conversationLifecycle: ConversationLifecycleService
  private readonly sessionLifecycle: SessionLifecycleService
  private readonly investigationLifecycle: InvestigationLifecycleService
  private readonly knowledgeRepo: KnowledgeRepository
  private readonly knowledgeService: KnowledgeService
  private readonly codeRefs: CodeRefRepository
  private readonly embeddingStore: EmbeddingStore
  private readonly embeddingProviderPromise: Promise<EmbeddingProvider>
  private embeddingReadyPromise: Promise<void> | null = null

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    const vecLoaded = loadVecExtension(this.db)
    initSchema(this.db)
    this.embeddingStore = new EmbeddingStore(this.db, vecLoaded)
    this.embeddingProviderPromise = loadEmbeddingProvider().catch((err) => {
      console.warn('[choda-deck] embedding provider load failed:', (err as Error).message)
      throw err
    })

    this.projects = new ProjectRepository(this.db)
    this.workspaces = new WorkspaceRepository(this.db)
    this.relationships = new RelationshipRepository(this.db)
    this.counters = new CounterRepository(this.db)
    this.toolInvocations = new ToolInvocationsRepository(this.db)
    this.sessionEvents = new SessionEventRepository(this.db)
    this.agentMemories = new AgentMemoryRepository(this.db)
    this.tasks = new TaskRepository(this.db, this.relationships, this.counters)
    this.documents = new DocumentRepository(this.db)
    this.tagsRepo = new TagRepository(this.db)
    this.sessions = new SessionRepository(this.db)
    this.contextSources = new ContextSourceRepository(this.db)
    this.conversations = new ConversationRepository(this.db)
    this.inbox = new InboxRepository(this.db, this.counters)
    this.investigations = new InvestigationRepository(this.db, this.counters)
    this.investigationLifecycle = new InvestigationLifecycleService(this.db, this.investigations)
    this.inboxLifecycle = new InboxLifecycleService(
      this.db,
      this.inbox,
      this.conversations,
      this.tasks
    )
    this.conversationLifecycle = new ConversationLifecycleService(
      this.db,
      this.conversations,
      this.tasks,
      this.sessions
    )
    this.codeRefs = new CodeRefRepository(this.db)
    this.sessionLifecycle = new SessionLifecycleService(
      this.db,
      this.sessions,
      this.contextSources,
      this.conversations,
      this.tasks,
      this.sessionEvents,
      this.relationships,
      this.codeRefs,
      (input) => this.recallMemoriesSync(input)
    )
    this.knowledgeRepo = new KnowledgeRepository(this.db)
    this.knowledgeService = new KnowledgeService({
      knowledge: this.knowledgeRepo,
      projects: this.projects,
      workspaces: this.workspaces,
      embeddingStore: this.embeddingStore,
      embeddingProvider: () => this.embeddingProviderPromise,
      edges: this.relationships
    })
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  async initialize(): Promise<void> {
    /* schema bootstrapped in constructor */
  }
  async initializeAsync(): Promise<void> {
    if (this.embeddingReadyPromise) return this.embeddingReadyPromise
    this.embeddingReadyPromise = (async (): Promise<void> => {
      let provider: EmbeddingProvider
      try {
        provider = await this.embeddingProviderPromise
      } catch {
        return
      }
      const report = this.embeddingStore.ensureSchema(provider)
      if (report.reembeddedAll) {
        console.warn(
          `[choda-deck] embedding provider switched ${report.previousProviderId} → ${report.activeProviderId}; cleared per-row embeddings, run backfill to repopulate`
        )
      }
    })()
    return this.embeddingReadyPromise
  }
  async close(): Promise<void> {
    this.db.close()
  }

  async backup(absolutePath: string): Promise<void> {
    const escaped = absolutePath.replace(/'/g, "''")
    this.db.exec(`VACUUM INTO '${escaped}'`)
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

  async ensureProject(id: string, name: string, cwd: string): Promise<void> {
    this.projects.ensure(id, name, cwd)
  }

  async getProject(id: string): Promise<ProjectRow | null> {
    return this.projects.get(id)
  }

  async listProjects(): Promise<ProjectRow[]> {
    return this.projects.list()
  }
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
    this.tasks.delete(id)
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
    this.tasks.addDependency(sourceId, targetId)
  }
  async removeDependency(sourceId: string, targetId: string): Promise<void> {
    this.tasks.removeDependency(sourceId, targetId)
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
    this.documents.delete(id)
  }
  async getDocument(id: string): Promise<Document | null> {
    return this.documents.get(id)
  }
  async findDocuments(projectId: string, type?: DocumentType): Promise<Document[]> {
    return this.documents.findByProject(projectId, type)
  }

  // ── Tags ───────────────────────────────────────────────────────────────────
  async addTag(itemId: string, tag: string): Promise<void> {
    this.tagsRepo.add(itemId, tag)
  }
  async removeTag(itemId: string, tag: string): Promise<void> {
    this.tagsRepo.remove(itemId, tag)
  }
  async getTags(itemId: string): Promise<string[]> {
    return this.tagsRepo.getForItem(itemId)
  }
  async findByTag(tag: string): Promise<string[]> {
    return this.tagsRepo.findItemsByTag(tag)
  }

  // ── Relationships ──────────────────────────────────────────────────────────
  async addRelationship(fromId: string, toId: string, type: RelationType): Promise<void> {
    this.relationships.add(fromId, toId, type)
  }
  async removeRelationship(fromId: string, toId: string, type: RelationType): Promise<void> {
    this.relationships.remove(fromId, toId, type)
  }
  async getRelationships(itemId: string): Promise<Relationship[]> {
    return this.relationships.getForItem(itemId)
  }
  async getRelationshipsFrom(itemId: string, type?: RelationType): Promise<Relationship[]> {
    return this.relationships.getFrom(itemId, type)
  }
  async getRelationshipsTo(itemId: string, type?: RelationType): Promise<Relationship[]> {
    return this.relationships.getTo(itemId, type)
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
    this.sessions.delete(id)
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
    this.contextSources.delete(id)
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
    this.conversations.delete(id)
  }

  async addConversationParticipant(conversationId: string, name: string): Promise<void> {
    this.conversations.addParticipant(conversationId, name)
  }
  async removeConversationParticipant(conversationId: string, name: string): Promise<void> {
    this.conversations.removeParticipant(conversationId, name)
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
  async markConversationMessageRead(messageId: string, participantName: string): Promise<void> {
    this.conversations.markMessageRead(messageId, participantName)
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
    this.conversations.link(conversationId, linkedType, linkedId)
  }
  async unlinkConversation(
    conversationId: string,
    linkedType: ConversationLinkType,
    linkedId: string
  ): Promise<void> {
    this.conversations.unlink(conversationId, linkedType, linkedId)
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
    this.inbox.delete(id)
  }

  // ── Inbox lifecycle (composite, transactional) ─────────────────────────────
  async startInboxResearch(id: string, researcher: string): Promise<InboxResearchResult> {
    return this.inboxLifecycle.startInboxResearch(id, researcher)
  }
  async convertInboxToTask(id: string, input: InboxConvertInput): Promise<InboxConvertResult> {
    return this.inboxLifecycle.convertInboxToTask(id, input)
  }
  async archiveInbox(id: string, reason?: string): Promise<InboxItem> {
    return this.inboxLifecycle.archiveInbox(id, reason)
  }

  // ── Conversation lifecycle (composite, transactional) ──────────────────────
  async openConversation(input: OpenConversationInput): Promise<Conversation> {
    return this.conversationLifecycle.openConversation(input)
  }
  async decideConversation(id: string, input: DecideConversationInput): Promise<DecideConversationResult> {
    return this.conversationLifecycle.decideConversation(id, input)
  }
  async signoffConversation(id: string, name: string): Promise<SignoffConversationResult> {
    return this.conversationLifecycle.signoffConversation(id, name)
  }

  // ── Session lifecycle (composite, transactional) ──────────────────────────
  async startSession(input: StartSessionInput): Promise<StartSessionResult> {
    return this.sessionLifecycle.startSession(input)
  }
  async endSession(id: string, input: EndSessionInput): Promise<EndSessionResult> {
    return this.sessionLifecycle.endSession(id, input)
  }
  async abandonSession(id: string, reason: string): Promise<AbandonSessionResult> {
    return this.sessionLifecycle.abandonSession(id, reason)
  }
  async checkpointSession(id: string, input: CheckpointSessionInput): Promise<CheckpointSessionResult> {
    return this.sessionLifecycle.checkpointSession(id, input)
  }
  async resumeSession(id: string): Promise<ResumeSessionResult> {
    return this.sessionLifecycle.resumeSession(id)
  }

  // ── Investigation lifecycle (ADR-035, stdio-only) ──────────────────────────
  async startInvestigation(input: StartInvestigationInput): Promise<Investigation> {
    return this.investigationLifecycle.startInvestigation(input)
  }
  async addHypothesis(investigationId: string, description: string): Promise<Hypothesis> {
    return this.investigationLifecycle.addHypothesis(investigationId, description)
  }
  async setHypothesisStatus(hypothesisId: string, status: HypothesisStatus): Promise<Hypothesis> {
    return this.investigationLifecycle.setHypothesisStatus(hypothesisId, status)
  }
  async addEvidence(input: AddEvidenceInput): Promise<Evidence> {
    return this.investigationLifecycle.addEvidence(input)
  }
  async resolveInvestigation(
    id: string,
    input: ResolveInvestigationInput
  ): Promise<ResolveInvestigationResult> {
    return this.investigationLifecycle.resolveInvestigation(id, input)
  }
  async getInvestigation(id: string): Promise<Investigation | null> {
    return this.investigationLifecycle.getInvestigation(id)
  }

  // ── Knowledge ─────────────────────────────────────────────────────────────
  async createKnowledge(input: CreateKnowledgeInput): Promise<KnowledgeEntry> {
    return this.knowledgeService.createKnowledge(input)
  }
  async registerExistingKnowledge(input: RegisterExistingKnowledgeInput): Promise<KnowledgeEntry> {
    return this.knowledgeService.registerExistingKnowledge(input)
  }
  async getKnowledge(slug: string): Promise<KnowledgeEntry | null> {
    return this.knowledgeService.getKnowledge(slug)
  }
  async listKnowledge(filter?: KnowledgeListFilter): Promise<KnowledgeListItem[]> {
    return this.knowledgeService.listKnowledge(filter)
  }
  async updateKnowledge(input: UpdateKnowledgeInput): Promise<KnowledgeEntry> {
    return this.knowledgeService.updateKnowledge(input)
  }
  async verifyKnowledge(slug: string): Promise<KnowledgeVerifyResult> {
    return this.knowledgeService.verifyKnowledge(slug)
  }
  async deleteKnowledge(slug: string): Promise<{ slug: string; deletedFile: boolean }> {
    return this.knowledgeService.deleteKnowledge(slug)
  }
  searchKnowledge(query: string, k?: number): Promise<KnowledgeSearchResult> {
    return this.knowledgeService.searchKnowledge(query, k)
  }

  // ── Code refs + TOUCHES edges (TASK-988) ────────────────────────────────────
  async upsertCodeRef(input: UpsertCodeRefInput): Promise<CodeRefRow> {
    return this.codeRefs.upsert(input, new Date().toISOString().slice(0, 10))
  }
  async getCodeRef(slug: string): Promise<CodeRefRow | null> {
    return this.codeRefs.get(slug)
  }
  async listCodeRefsByPrefix(filter: CodeRefPrefixFilter): Promise<CodeRefRow[]> {
    return this.codeRefs.listByPrefix(filter)
  }
  async deleteCodeRef(slug: string): Promise<void> {
    this.codeRefs.delete(slug)
  }
  async addTouches(taskId: string, codeRefSlug: string, relation: TouchesRelation): Promise<void> {
    this.codeRefs.addTouches(taskId, codeRefSlug, relation)
  }
  async removeTouches(taskId: string, codeRefSlug: string): Promise<void> {
    this.codeRefs.removeTouches(taskId, codeRefSlug)
  }
  async getTouchesForTask(taskId: string): Promise<TouchesEdge[]> {
    return this.codeRefs.getTouchesForTask(taskId)
  }
  async getTouchesForCodeRef(codeRefSlug: string): Promise<TouchesEdge[]> {
    return this.codeRefs.getTouchesForCodeRef(codeRefSlug)
  }

  // ── Session Events ─────────────────────────────────────────────────────────
  async createSessionEvent(input: import('./task-types').CreateSessionEventInput): Promise<import('./task-types').SessionEvent> {
    return this.sessionEvents.create(input)
  }

  async listSessionEvents(
    sessionId: string,
    eventType?: import('./task-types').SessionEventType,
    limit?: number
  ): Promise<import('./task-types').SessionEvent[]> {
    const all = this.sessionEvents.listBySession(sessionId, eventType)
    return limit !== undefined ? all.slice(0, limit) : all
  }

  // ADR-029 channel 2: narrow body-lock bypass — flip one AC checkbox and emit
  // an `ac_check` observation event in a single transaction. The MCP layer
  // (ac-check.ts) resolves cwd → workspaceId before calling; this method takes
  // an already-resolved workspaceId (or undefined to match any active session
  // in the project).
  async checkAcItem(input: CheckAcItemInput): Promise<CheckAcItemResult> {
    const task = this.tasks.get(input.taskId)
    if (!task) throw new TaskNotFoundError(input.taskId)

    const { newBody, item } = flipAcCheckbox(task.body ?? '', task.id, input.acIndex)

    const session = this.sessions.getActive(task.projectId, input.workspaceId)
    if (!session) throw new NoActiveSessionError(task.projectId, input.workspaceId ?? null)

    const tx = this.db.transaction((): CheckAcItemResult => {
      this.tasks.update(task.id, { body: newBody })
      const event = this.sessionEvents.create({
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
    return tx()
  }

  // ── Agent Memories ─────────────────────────────────────────────────────────
  async writeMemory(input: MemoryWriteInput): Promise<import('./task-types').AgentMemory> {
    return this.agentMemories.create(input)
  }

  async recallMemories(input: MemoryRecallInput): Promise<import('./task-types').AgentMemory[]> {
    return this.recallMemoriesSync(input)
  }

  private recallMemoriesSync(input: MemoryRecallInput): import('./task-types').AgentMemory[] {
    const { taskId, workspaceId, projectId, userId, tags, limit } = input
    const seen = new Set<string>()
    const merged: import('./task-types').AgentMemory[] = []

    const collect = (scopeType: import('./task-types').MemoryScopeType, scopeId: string): void => {
      const rows = this.agentMemories.recall({ scopeType, scopeId, tags, limit })
      for (const row of rows) {
        if (!seen.has(row.id)) {
          seen.add(row.id)
          merged.push(row)
        }
      }
    }

    if (taskId) collect('task', taskId)
    if (workspaceId) collect('workspace', workspaceId)
    if (projectId) collect('project', projectId)
    if (userId) collect('user', userId)

    merged.sort((a, b) => b.importance - a.importance || b.recallCount - a.recallCount)

    const result = limit !== undefined ? merged.slice(0, limit) : merged
    for (const m of result) {
      this.agentMemories.updateRecallStats(m.id)
    }
    return result
  }

  async markMemoryPromoted(memoryId: string, adrSlug: string): Promise<void> {
    this.agentMemories.promoteMarkPromoted(memoryId, adrSlug)
  }
}

// Loads the sqlite-vec native extension on the given connection. Returns false
// if the platform binary is missing (e.g. user did not install optional native
// pkg) — embedding features then degrade gracefully.
function loadVecExtension(db: Database.Database): boolean {
  try {
    sqliteVec.load(db)
    return true
  } catch (err) {
    console.warn(
      '[choda-deck] sqlite-vec extension not loaded — semantic search disabled:',
      (err as Error).message
    )
    return false
  }
}
