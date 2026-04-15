import Database from 'better-sqlite3'
import type { TaskService } from './task-service.interface'
import type { SessionOperations } from './interfaces/session-repository.interface'
import type { ContextSourceOperations } from './interfaces/context-source-repository.interface'
import type { ConversationOperations } from './interfaces/conversation-repository.interface'
import type {
  Task, CreateTaskInput, UpdateTaskInput, TaskFilter, TaskDependency,
  Phase, CreatePhaseInput, UpdatePhaseInput,
  Feature, CreateFeatureInput, UpdateFeatureInput,
  Document, DocumentType, CreateDocumentInput, UpdateDocumentInput,
  Relationship, RelationType,
  DerivedProgress,
  Session, SessionStatus, CreateSessionInput, UpdateSessionInput,
  ContextSource, CreateContextSourceInput, UpdateContextSourceInput,
  Conversation, ConversationStatus,
  ConversationMessage, ConversationLink, ConversationLinkType,
  ConversationParticipant, ConversationParticipantType,
  ConversationAction,
  CreateConversationInput, UpdateConversationInput,
  CreateConversationMessageInput, CreateConversationActionInput, UpdateConversationActionInput
} from './task-types'

import { initSchema } from './repositories/schema'
import { ProjectRepository } from './repositories/project-repository'
import { TaskRepository } from './repositories/task-repository'
import { PhaseRepository } from './repositories/phase-repository'
import { FeatureRepository } from './repositories/feature-repository'
import { DocumentRepository } from './repositories/document-repository'
import { TagRepository } from './repositories/tag-repository'
import { RelationshipRepository } from './repositories/relationship-repository'
import { SessionRepository } from './repositories/session-repository'
import { ContextSourceRepository } from './repositories/context-source-repository'
import { ConversationRepository } from './repositories/conversation-repository'

export class SqliteTaskService implements
  TaskService, SessionOperations, ContextSourceOperations, ConversationOperations
{
  private readonly db: Database.Database
  private readonly projects: ProjectRepository
  private readonly tasks: TaskRepository
  private readonly phases: PhaseRepository
  private readonly features: FeatureRepository
  private readonly documents: DocumentRepository
  private readonly tagsRepo: TagRepository
  private readonly relationships: RelationshipRepository
  private readonly sessions: SessionRepository
  private readonly contextSources: ContextSourceRepository
  private readonly conversations: ConversationRepository

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    initSchema(this.db)

    this.projects = new ProjectRepository(this.db)
    this.relationships = new RelationshipRepository(this.db)
    this.tasks = new TaskRepository(this.db, this.relationships)
    this.phases = new PhaseRepository(this.db)
    this.features = new FeatureRepository(this.db)
    this.documents = new DocumentRepository(this.db)
    this.tagsRepo = new TagRepository(this.db)
    this.sessions = new SessionRepository(this.db)
    this.contextSources = new ContextSourceRepository(this.db)
    this.conversations = new ConversationRepository(this.db)
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  initialize(): void { /* schema bootstrapped in constructor */ }
  async initializeAsync(): Promise<void> { /* no-op */ }
  close(): void { this.db.close() }

  ensureProject(id: string, name: string, cwd: string): void {
    this.projects.ensure(id, name, cwd)
  }

  getProject(id: string): { id: string; name: string; cwd: string } | null {
    return this.projects.get(id)
  }

  // ── Task operations ────────────────────────────────────────────────────────
  createTask(input: CreateTaskInput): Task { return this.tasks.create(input) }
  updateTask(id: string, input: UpdateTaskInput): Task { return this.tasks.update(id, input) }
  deleteTask(id: string): void { this.tasks.delete(id) }
  getTask(id: string): Task | null { return this.tasks.get(id) }
  findTasks(filter: TaskFilter): Task[] { return this.tasks.find(filter) }
  getSubtasks(parentId: string): Task[] { return this.tasks.getSubtasks(parentId) }
  getPinnedTasks(): Task[] { return this.tasks.getPinned() }
  getDueTasks(date: string): Task[] { return this.tasks.getDue(date) }
  addDependency(sourceId: string, targetId: string): void { this.tasks.addDependency(sourceId, targetId) }
  removeDependency(sourceId: string, targetId: string): void { this.tasks.removeDependency(sourceId, targetId) }
  getDependencies(taskId: string): TaskDependency[] { return this.tasks.getDependencies(taskId) }

  // ── Phase operations ───────────────────────────────────────────────────────
  createPhase(input: CreatePhaseInput): Phase { return this.phases.create(input) }
  updatePhase(id: string, input: UpdatePhaseInput): Phase { return this.phases.update(id, input) }
  deletePhase(id: string): void { this.phases.delete(id) }
  getPhase(id: string): Phase | null { return this.phases.get(id) }
  findPhases(projectId: string): Phase[] { return this.phases.findByProject(projectId) }
  getPhaseProgress(phaseId: string): DerivedProgress { return this.phases.getProgress(phaseId) }

  // ── Feature operations ─────────────────────────────────────────────────────
  createFeature(input: CreateFeatureInput): Feature { return this.features.create(input) }
  updateFeature(id: string, input: UpdateFeatureInput): Feature { return this.features.update(id, input) }
  deleteFeature(id: string): void { this.features.delete(id) }
  getFeature(id: string): Feature | null { return this.features.get(id) }
  findFeatures(projectId: string): Feature[] { return this.features.findByProject(projectId) }
  findFeaturesByPhase(phaseId: string): Feature[] { return this.features.findByPhase(phaseId) }
  getFeatureProgress(featureId: string): DerivedProgress { return this.features.getProgress(featureId) }

  // ── Document operations ────────────────────────────────────────────────────
  createDocument(input: CreateDocumentInput): Document { return this.documents.create(input) }
  updateDocument(id: string, input: UpdateDocumentInput): Document { return this.documents.update(id, input) }
  deleteDocument(id: string): void { this.documents.delete(id) }
  getDocument(id: string): Document | null { return this.documents.get(id) }
  findDocuments(projectId: string, type?: DocumentType): Document[] { return this.documents.findByProject(projectId, type) }

  // ── Tags ───────────────────────────────────────────────────────────────────
  addTag(itemId: string, tag: string): void { this.tagsRepo.add(itemId, tag) }
  removeTag(itemId: string, tag: string): void { this.tagsRepo.remove(itemId, tag) }
  getTags(itemId: string): string[] { return this.tagsRepo.getForItem(itemId) }
  findByTag(tag: string): string[] { return this.tagsRepo.findItemsByTag(tag) }

  // ── Relationships ──────────────────────────────────────────────────────────
  addRelationship(fromId: string, toId: string, type: RelationType): void { this.relationships.add(fromId, toId, type) }
  removeRelationship(fromId: string, toId: string, type: RelationType): void { this.relationships.remove(fromId, toId, type) }
  getRelationships(itemId: string): Relationship[] { return this.relationships.getForItem(itemId) }
  getRelationshipsFrom(itemId: string, type?: RelationType): Relationship[] { return this.relationships.getFrom(itemId, type) }

  // ── Session operations (M1) ────────────────────────────────────────────────
  createSession(input: CreateSessionInput): Session { return this.sessions.create(input) }
  updateSession(id: string, input: UpdateSessionInput): Session { return this.sessions.update(id, input) }
  getSession(id: string): Session | null { return this.sessions.get(id) }
  findSessions(projectId: string, status?: SessionStatus): Session[] { return this.sessions.findByProject(projectId, status) }
  getActiveSession(projectId: string): Session | null { return this.sessions.getActive(projectId) }
  deleteSession(id: string): void { this.sessions.delete(id) }

  // ── Context source operations (M1) ─────────────────────────────────────────
  createContextSource(input: CreateContextSourceInput): ContextSource { return this.contextSources.create(input) }
  updateContextSource(id: string, input: UpdateContextSourceInput): ContextSource { return this.contextSources.update(id, input) }
  getContextSource(id: string): ContextSource | null { return this.contextSources.get(id) }
  findContextSources(projectId: string, activeOnly = false): ContextSource[] { return this.contextSources.findByProject(projectId, activeOnly) }
  deleteContextSource(id: string): void { this.contextSources.delete(id) }

  // ── Conversation operations (M1) ───────────────────────────────────────────
  createConversation(input: CreateConversationInput): Conversation { return this.conversations.create(input) }
  updateConversation(id: string, input: UpdateConversationInput): Conversation { return this.conversations.update(id, input) }
  getConversation(id: string): Conversation | null { return this.conversations.get(id) }
  findConversations(projectId: string, status?: ConversationStatus): Conversation[] { return this.conversations.findByProject(projectId, status) }
  deleteConversation(id: string): void { this.conversations.delete(id) }

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

  linkConversation(conversationId: string, linkedType: ConversationLinkType, linkedId: string): void {
    this.conversations.link(conversationId, linkedType, linkedId)
  }
  unlinkConversation(conversationId: string, linkedType: ConversationLinkType, linkedId: string): void {
    this.conversations.unlink(conversationId, linkedType, linkedId)
  }
  getConversationLinks(conversationId: string): ConversationLink[] {
    return this.conversations.getLinks(conversationId)
  }
  findConversationsByLink(linkedType: ConversationLinkType, linkedId: string): Conversation[] {
    return this.conversations.findByLink(linkedType, linkedId)
  }
}
