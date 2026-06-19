// Postgres facade — implements RemoteOperations (strict subset of
// BackendTaskService). Backs the HTTP transport only; stdio uses SQLite.
//
// Narrowed from the full 16-repo adapter (TASK-934 slices 1–21) on 2026-05-28
// per the standing rule in ADR-026 §Per-tool scoping: PG surface = the call
// graph of REMOTE_TOOL_ALLOWLIST. Anything outside that set (sessions,
// conversation writes, knowledge, memory, embeddings, session events,
// agent memories, tool invocations, documents, lifecycle composites) was
// deleted because no remote tool can ever reach it. Restore from git history
// if/when tier-2 allowlist expansion (INBOX-391) requires it.
//
// Schema migrations run inside initializeAsync — callers (factory + server
// bootstrap) already await it before first use.

import type { RemoteOperations } from './remote-operations.interface'
import { PgConnection } from './repositories/postgres/connection'
import { migrate } from './repositories/postgres/migrations'
import { fetchSinceFromPg } from '../sync/sync-source'
import { applyDeltaToPg } from '../sync/sync-sink'
import type { TableDelta } from '../sync/sync-pull'
import type { ApplyResult } from '../sync/sync-apply'
import { PostgresProjectRepository } from './repositories/postgres/project-repository.pg'
import { PostgresWorkspaceRepository } from './repositories/postgres/workspace-repository.pg'
import { PostgresTaskRepository } from './repositories/postgres/task-repository.pg'
import { PostgresTagRepository } from './repositories/postgres/tag-repository.pg'
import { PostgresRelationshipRepository } from './repositories/postgres/relationship-repository.pg'
import { PostgresConversationRepository } from './repositories/postgres/conversation-repository.pg'
import { PostgresInboxRepository } from './repositories/postgres/inbox-repository.pg'
import { PostgresCounterRepository } from './repositories/postgres/counter-repository.pg'
import type { ProjectRow } from './repositories/project-repository'
import type { WorkspaceRow } from './repositories/workspace-repository'
import type {
  Task,
  TaskFilter,
  TaskDependency,
  Relationship,
  InboxItem,
  InboxFilter,
  CreateInboxInput,
  Conversation,
  ConversationLink,
  ConversationLinkType,
  ConversationMessage,
  ConversationAction,
  ConversationParticipant,
  ConversationStatus,
  CreateConversationMessageInput
} from './task-types'
import type { OpenConversationInput } from './interfaces/conversation-lifecycle.interface'

export class PostgresTaskService implements RemoteOperations {
  private readonly conn: PgConnection
  private readonly projects: PostgresProjectRepository
  private readonly workspaces: PostgresWorkspaceRepository
  private readonly tasks: PostgresTaskRepository
  private readonly tagsRepo: PostgresTagRepository
  private readonly relationships: PostgresRelationshipRepository
  private readonly conversations: PostgresConversationRepository
  private readonly inbox: PostgresInboxRepository
  private readonly counters: PostgresCounterRepository
  private migrationsRanPromise: Promise<void> | null = null

  constructor(conn: PgConnection) {
    this.conn = conn
    this.projects = new PostgresProjectRepository(conn)
    this.workspaces = new PostgresWorkspaceRepository(conn)
    this.relationships = new PostgresRelationshipRepository(conn)
    this.counters = new PostgresCounterRepository(conn)
    this.tasks = new PostgresTaskRepository(conn)
    this.tagsRepo = new PostgresTagRepository(conn)
    this.conversations = new PostgresConversationRepository(conn)
    this.inbox = new PostgresInboxRepository(conn, this.counters)
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

  async getProject(id: string): Promise<ProjectRow | null> {
    return this.projects.get(id)
  }

  async listProjects(): Promise<ProjectRow[]> {
    return this.projects.list()
  }

  async findWorkspaces(projectId: string, includeArchived = false): Promise<WorkspaceRow[]> {
    return this.workspaces.findByProject(projectId, includeArchived)
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

  async getDependencies(taskId: string): Promise<TaskDependency[]> {
    return this.tasks.getDependencies(taskId)
  }

  async getTags(itemId: string): Promise<string[]> {
    return this.tagsRepo.getForItem(itemId)
  }

  async getRelationships(itemId: string): Promise<Relationship[]> {
    return this.relationships.getForItem(itemId)
  }

  async findInbox(filter: InboxFilter): Promise<InboxItem[]> {
    return this.inbox.find(filter)
  }

  async getInbox(id: string): Promise<InboxItem | null> {
    return this.inbox.get(id)
  }

  async createInbox(input: CreateInboxInput): Promise<InboxItem> {
    return this.inbox.create(input)
  }

  async findConversationsByLink(
    linkedType: ConversationLinkType,
    linkedId: string
  ): Promise<Conversation[]> {
    return this.conversations.findByLink(linkedType, linkedId)
  }

  async getConversationMessages(conversationId: string): Promise<ConversationMessage[]> {
    return this.conversations.getMessages(conversationId)
  }

  async getConversationActions(conversationId: string): Promise<ConversationAction[]> {
    return this.conversations.getActions(conversationId)
  }

  // ── TASK-1136 (AC-4) — conversation tools on the remote allowlist ──
  // Append-only: open seeds the conversation + initial message + participants +
  // task links (no session resolve — sessions are stdio-only on this surface).
  // decide/signoff stay stdio-only; a decision reaches PG only via sync, where
  // applyDeltaToPg recomputes the header.
  async openConversation(input: OpenConversationInput): Promise<Conversation> {
    const conv = await this.conversations.create({
      projectId: input.projectId,
      title: input.title,
      createdBy: input.createdBy,
      participants: input.participants
    })
    await this.conversations.addMessage({
      conversationId: conv.id,
      authorName: input.createdBy,
      content: input.initialMessage.content
    })
    for (const taskId of input.linkedTasks ?? []) {
      await this.conversations.link(conv.id, 'task', taskId)
    }
    return (await this.conversations.get(conv.id))!
  }

  async addConversationMessage(input: CreateConversationMessageInput): Promise<ConversationMessage> {
    return this.conversations.addMessage(input)
  }

  async getConversation(id: string): Promise<Conversation | null> {
    return this.conversations.get(id)
  }

  async findConversations(projectId: string, status?: ConversationStatus): Promise<Conversation[]> {
    return this.conversations.findByProject(projectId, status)
  }

  async getConversationParticipants(conversationId: string): Promise<ConversationParticipant[]> {
    return this.conversations.getParticipants(conversationId)
  }

  async getConversationLinks(conversationId: string): Promise<ConversationLink[]> {
    return this.conversations.getLinks(conversationId)
  }

  async markConversationMessageRead(messageId: string, participantName: string): Promise<void> {
    return this.conversations.markRead(messageId, participantName)
  }

  async fetchSince(since: number): Promise<TableDelta[]> {
    return fetchSinceFromPg(this.conn, since)
  }

  async applyDelta(deltas: TableDelta[], origin: string): Promise<ApplyResult> {
    return applyDeltaToPg(this.conn, deltas, origin)
  }
}
