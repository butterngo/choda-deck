import Database from 'better-sqlite3'
import type { TaskService } from './task-service.interface'
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
  DecideConversationResult
} from './interfaces/conversation-lifecycle.interface'
import type {
  SessionLifecycleOperations,
  StartSessionInput,
  StartSessionResult,
  EndSessionInput,
  EndSessionResult,
  CheckpointSessionInput,
  CheckpointSessionResult,
  ResumeSessionResult
} from './interfaces/session-lifecycle.interface'
import { InboxLifecycleService } from './lifecycle/inbox-lifecycle-service'
import { ConversationLifecycleService } from './lifecycle/conversation-lifecycle-service'
import { SessionLifecycleService } from './lifecycle/session-lifecycle-service'
import { KnowledgeService } from './knowledge-service'
import { KnowledgeRepository } from './repositories/knowledge-repository'
import type { KnowledgeOperations } from './interfaces/knowledge-operations.interface'
import type {
  CreateKnowledgeInput,
  KnowledgeEntry,
  KnowledgeListFilter,
  KnowledgeListItem,
  KnowledgeVerifyResult
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
  InboxFilter
} from './task-types'

import { initSchema } from './repositories/schema'
import { ProjectRepository } from './repositories/project-repository'
import type { ProjectRow } from './repositories/project-repository'
import { WorkspaceRepository } from './repositories/workspace-repository'
import type { WorkspaceRow, WorkspaceReferenceCounts } from './repositories/workspace-repository'
import { TaskRepository } from './repositories/task-repository'
import { DocumentRepository } from './repositories/document-repository'
import { TagRepository } from './repositories/tag-repository'
import { RelationshipRepository } from './repositories/relationship-repository'
import { SessionRepository } from './repositories/session-repository'
import { ContextSourceRepository } from './repositories/context-source-repository'
import { ConversationRepository } from './repositories/conversation-repository'
import { InboxRepository } from './repositories/inbox-repository'
import { CounterRepository } from './repositories/counter-repository'

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
    KnowledgeOperations
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
  private readonly inboxLifecycle: InboxLifecycleService
  private readonly conversationLifecycle: ConversationLifecycleService
  private readonly sessionLifecycle: SessionLifecycleService
  private readonly knowledgeRepo: KnowledgeRepository
  private readonly knowledgeService: KnowledgeService

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    initSchema(this.db)

    this.projects = new ProjectRepository(this.db)
    this.workspaces = new WorkspaceRepository(this.db)
    this.relationships = new RelationshipRepository(this.db)
    this.counters = new CounterRepository(this.db)
    this.tasks = new TaskRepository(this.db, this.relationships, this.counters)
    this.documents = new DocumentRepository(this.db)
    this.tagsRepo = new TagRepository(this.db)
    this.sessions = new SessionRepository(this.db)
    this.contextSources = new ContextSourceRepository(this.db)
    this.conversations = new ConversationRepository(this.db)
    this.inbox = new InboxRepository(this.db, this.counters)
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
    this.sessionLifecycle = new SessionLifecycleService(
      this.db,
      this.sessions,
      this.contextSources,
      this.conversations,
      this.tasks
    )
    this.knowledgeRepo = new KnowledgeRepository(this.db)
    this.knowledgeService = new KnowledgeService({
      db: this.db,
      knowledge: this.knowledgeRepo,
      projects: this.projects
    })
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  initialize(): void {
    /* schema bootstrapped in constructor */
  }
  async initializeAsync(): Promise<void> {
    /* no-op */
  }
  close(): void {
    this.db.close()
  }

  backup(absolutePath: string): void {
    const escaped = absolutePath.replace(/'/g, "''")
    this.db.exec(`VACUUM INTO '${escaped}'`)
  }

  ensureProject(id: string, name: string, cwd: string): void {
    this.projects.ensure(id, name, cwd)
  }

  getProject(id: string): ProjectRow | null {
    return this.projects.get(id)
  }

  listProjects(): ProjectRow[] {
    return this.projects.list()
  }
  addWorkspace(projectId: string, id: string, label: string, cwd: string): WorkspaceRow {
    return this.workspaces.add(projectId, id, label, cwd)
  }
  getWorkspace(id: string): WorkspaceRow | null {
    return this.workspaces.get(id)
  }
  findWorkspaces(projectId: string, includeArchived = false): WorkspaceRow[] {
    return this.workspaces.findByProject(projectId, includeArchived)
  }
  archiveWorkspace(id: string): WorkspaceRow | null {
    return this.workspaces.archive(id)
  }
  unarchiveWorkspace(id: string): WorkspaceRow | null {
    return this.workspaces.unarchive(id)
  }
  deleteWorkspace(id: string): void {
    this.workspaces.delete(id)
  }
  countWorkspaceReferences(id: string): WorkspaceReferenceCounts {
    return this.workspaces.countReferences(id)
  }

  // ── Task operations ────────────────────────────────────────────────────────
  createTask(input: CreateTaskInput): Task {
    return this.tasks.create(input)
  }
  updateTask(id: string, input: UpdateTaskInput): Task {
    return this.tasks.update(id, input)
  }
  deleteTask(id: string): void {
    this.tasks.delete(id)
  }
  getTask(id: string): Task | null {
    return this.tasks.get(id)
  }
  findTasks(filter: TaskFilter): Task[] {
    return this.tasks.find(filter)
  }
  getSubtasks(parentId: string): Task[] {
    return this.tasks.getSubtasks(parentId)
  }
  getPinnedTasks(): Task[] {
    return this.tasks.getPinned()
  }
  getDueTasks(date: string): Task[] {
    return this.tasks.getDue(date)
  }
  addDependency(sourceId: string, targetId: string): void {
    this.tasks.addDependency(sourceId, targetId)
  }
  removeDependency(sourceId: string, targetId: string): void {
    this.tasks.removeDependency(sourceId, targetId)
  }
  getDependencies(taskId: string): TaskDependency[] {
    return this.tasks.getDependencies(taskId)
  }

  // ── Document operations ────────────────────────────────────────────────────
  createDocument(input: CreateDocumentInput): Document {
    return this.documents.create(input)
  }
  updateDocument(id: string, input: UpdateDocumentInput): Document {
    return this.documents.update(id, input)
  }
  deleteDocument(id: string): void {
    this.documents.delete(id)
  }
  getDocument(id: string): Document | null {
    return this.documents.get(id)
  }
  findDocuments(projectId: string, type?: DocumentType): Document[] {
    return this.documents.findByProject(projectId, type)
  }

  // ── Tags ───────────────────────────────────────────────────────────────────
  addTag(itemId: string, tag: string): void {
    this.tagsRepo.add(itemId, tag)
  }
  removeTag(itemId: string, tag: string): void {
    this.tagsRepo.remove(itemId, tag)
  }
  getTags(itemId: string): string[] {
    return this.tagsRepo.getForItem(itemId)
  }
  findByTag(tag: string): string[] {
    return this.tagsRepo.findItemsByTag(tag)
  }

  // ── Relationships ──────────────────────────────────────────────────────────
  addRelationship(fromId: string, toId: string, type: RelationType): void {
    this.relationships.add(fromId, toId, type)
  }
  removeRelationship(fromId: string, toId: string, type: RelationType): void {
    this.relationships.remove(fromId, toId, type)
  }
  getRelationships(itemId: string): Relationship[] {
    return this.relationships.getForItem(itemId)
  }
  getRelationshipsFrom(itemId: string, type?: RelationType): Relationship[] {
    return this.relationships.getFrom(itemId, type)
  }

  // ── Session operations (M1) ────────────────────────────────────────────────
  createSession(input: CreateSessionInput): Session {
    return this.sessions.create(input)
  }
  updateSession(id: string, input: UpdateSessionInput): Session {
    return this.sessions.update(id, input)
  }
  getSession(id: string): Session | null {
    return this.sessions.get(id)
  }
  findSessions(projectId: string, status?: SessionStatus): Session[] {
    return this.sessions.findByProject(projectId, status)
  }
  getActiveSession(projectId: string, workspaceId?: string): Session | null {
    return this.sessions.getActive(projectId, workspaceId)
  }
  deleteSession(id: string): void {
    this.sessions.delete(id)
  }

  // ── Context source operations (M1) ─────────────────────────────────────────
  createContextSource(input: CreateContextSourceInput): ContextSource {
    return this.contextSources.create(input)
  }
  updateContextSource(id: string, input: UpdateContextSourceInput): ContextSource {
    return this.contextSources.update(id, input)
  }
  getContextSource(id: string): ContextSource | null {
    return this.contextSources.get(id)
  }
  findContextSources(projectId: string, activeOnly = false): ContextSource[] {
    return this.contextSources.findByProject(projectId, activeOnly)
  }
  deleteContextSource(id: string): void {
    this.contextSources.delete(id)
  }

  // ── Conversation operations (M1) ───────────────────────────────────────────
  createConversation(input: CreateConversationInput): Conversation {
    return this.conversations.create(input)
  }
  updateConversation(id: string, input: UpdateConversationInput): Conversation {
    return this.conversations.update(id, input)
  }
  getConversation(id: string): Conversation | null {
    return this.conversations.get(id)
  }
  findConversations(projectId: string, status?: ConversationStatus): Conversation[] {
    return this.conversations.findByProject(projectId, status)
  }
  deleteConversation(id: string): void {
    this.conversations.delete(id)
  }

  addConversationParticipant(
    conversationId: string,
    name: string,
    type: ConversationParticipantType,
    role?: string | null
  ): void {
    this.conversations.addParticipant(conversationId, name, type, role)
  }
  removeConversationParticipant(conversationId: string, name: string): void {
    this.conversations.removeParticipant(conversationId, name)
  }
  getConversationParticipants(conversationId: string): ConversationParticipant[] {
    return this.conversations.getParticipants(conversationId)
  }

  addConversationMessage(input: CreateConversationMessageInput): ConversationMessage {
    return this.conversations.addMessage(input)
  }
  getConversationMessages(conversationId: string): ConversationMessage[] {
    return this.conversations.getMessages(conversationId)
  }

  addConversationAction(input: CreateConversationActionInput): ConversationAction {
    return this.conversations.addAction(input)
  }
  updateConversationAction(id: string, input: UpdateConversationActionInput): ConversationAction {
    return this.conversations.updateAction(id, input)
  }
  getConversationActions(conversationId: string): ConversationAction[] {
    return this.conversations.getActions(conversationId)
  }

  linkConversation(
    conversationId: string,
    linkedType: ConversationLinkType,
    linkedId: string
  ): void {
    this.conversations.link(conversationId, linkedType, linkedId)
  }
  unlinkConversation(
    conversationId: string,
    linkedType: ConversationLinkType,
    linkedId: string
  ): void {
    this.conversations.unlink(conversationId, linkedType, linkedId)
  }
  getConversationLinks(conversationId: string): ConversationLink[] {
    return this.conversations.getLinks(conversationId)
  }
  findConversationsByLink(linkedType: ConversationLinkType, linkedId: string): Conversation[] {
    return this.conversations.findByLink(linkedType, linkedId)
  }

  // ── Inbox ──────────────────────────────────────────────────────────────────
  createInbox(input: CreateInboxInput): InboxItem {
    return this.inbox.create(input)
  }
  updateInbox(id: string, input: UpdateInboxInput): InboxItem {
    return this.inbox.update(id, input)
  }
  getInbox(id: string): InboxItem | null {
    return this.inbox.get(id)
  }
  findInbox(filter: InboxFilter): InboxItem[] {
    return this.inbox.find(filter)
  }
  deleteInbox(id: string): void {
    this.inbox.delete(id)
  }

  // ── Inbox lifecycle (composite, transactional) ─────────────────────────────
  startInboxResearch(id: string, researcher: string): InboxResearchResult {
    return this.inboxLifecycle.startInboxResearch(id, researcher)
  }
  convertInboxToTask(id: string, input: InboxConvertInput): InboxConvertResult {
    return this.inboxLifecycle.convertInboxToTask(id, input)
  }
  archiveInbox(id: string, reason?: string): InboxItem {
    return this.inboxLifecycle.archiveInbox(id, reason)
  }

  // ── Conversation lifecycle (composite, transactional) ──────────────────────
  openConversation(input: OpenConversationInput): Conversation {
    return this.conversationLifecycle.openConversation(input)
  }
  decideConversation(id: string, input: DecideConversationInput): DecideConversationResult {
    return this.conversationLifecycle.decideConversation(id, input)
  }
  closeConversation(id: string): Conversation {
    return this.conversationLifecycle.closeConversation(id)
  }
  reopenConversation(id: string): Conversation {
    return this.conversationLifecycle.reopenConversation(id)
  }

  // ── Session lifecycle (composite, transactional) ──────────────────────────
  startSession(input: StartSessionInput): StartSessionResult {
    return this.sessionLifecycle.startSession(input)
  }
  endSession(id: string, input: EndSessionInput): EndSessionResult {
    return this.sessionLifecycle.endSession(id, input)
  }
  checkpointSession(id: string, input: CheckpointSessionInput): CheckpointSessionResult {
    return this.sessionLifecycle.checkpointSession(id, input)
  }
  resumeSession(id: string): ResumeSessionResult {
    return this.sessionLifecycle.resumeSession(id)
  }

  // ── Knowledge ─────────────────────────────────────────────────────────────
  createKnowledge(input: CreateKnowledgeInput): KnowledgeEntry {
    return this.knowledgeService.createKnowledge(input)
  }
  getKnowledge(slug: string): KnowledgeEntry | null {
    return this.knowledgeService.getKnowledge(slug)
  }
  listKnowledge(filter?: KnowledgeListFilter): KnowledgeListItem[] {
    return this.knowledgeService.listKnowledge(filter)
  }
  verifyKnowledge(slug: string): KnowledgeVerifyResult {
    return this.knowledgeService.verifyKnowledge(slug)
  }
  deleteKnowledge(slug: string): { slug: string; deletedFile: boolean } {
    return this.knowledgeService.deleteKnowledge(slug)
  }
}
