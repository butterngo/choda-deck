import type Database from 'better-sqlite3'
import type {
  Conversation,
  ConversationStatus,
  ConversationMessage,
  ConversationMessageType,
  ConversationMessageMetadata,
  ConversationLink,
  ConversationLinkType,
  ConversationParticipant,
  ConversationParticipantType,
  ConversationAction,
  ConversationActionStatus,
  CreateConversationInput,
  UpdateConversationInput,
  CreateConversationMessageInput,
  CreateConversationActionInput,
  UpdateConversationActionInput
} from '../task-types'
import { generateId, type Param } from './shared'

function rowToConversation(row: Record<string, unknown>): Conversation {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    title: row.title as string,
    status: row.status as ConversationStatus,
    createdBy: row.created_by as string,
    decisionSummary: (row.decision_summary as string) || null,
    createdAt: row.created_at as string,
    decidedAt: (row.decided_at as string) || null,
    closedAt: (row.closed_at as string) || null
  }
}

function rowToParticipant(row: Record<string, unknown>): ConversationParticipant {
  return {
    conversationId: row.conversation_id as string,
    name: row.participant_name as string,
    type: row.participant_type as ConversationParticipantType,
    role: (row.participant_role as string) || null
  }
}

function rowToMessage(row: Record<string, unknown>): ConversationMessage {
  return {
    id: row.id as string,
    conversationId: row.conversation_id as string,
    authorName: row.author_name as string,
    content: row.content as string,
    messageType: row.message_type as ConversationMessageType,
    metadata: row.metadata_json
      ? (JSON.parse(row.metadata_json as string) as ConversationMessageMetadata)
      : null,
    createdAt: row.created_at as string
  }
}

function rowToAction(row: Record<string, unknown>): ConversationAction {
  return {
    id: row.id as string,
    conversationId: row.conversation_id as string,
    assignee: row.assignee as string,
    description: row.description as string,
    status: row.status as ConversationActionStatus,
    linkedTaskId: (row.linked_task_id as string) || null,
    createdAt: row.created_at as string
  }
}

export class ConversationRepository {
  constructor(private readonly db: Database.Database) {}

  // ── Conversations ──────────────────────────────────────────────────────────

  create(input: CreateConversationInput): Conversation {
    const id = input.id || generateId('CONV')
    this.db
      .prepare(
        `INSERT INTO conversations (id, project_id, title, status, created_by, owner_type, owner_session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.projectId,
        input.title,
        input.status || 'open',
        input.createdBy,
        input.ownerType ?? null,
        input.ownerSessionId ?? null
      )

    if (input.participants) {
      for (const p of input.participants) {
        this.addParticipant(id, p.name, p.type, p.role)
      }
    }

    return this.get(id)!
  }

  update(id: string, input: UpdateConversationInput): Conversation {
    const sets: string[] = []
    const params: Param[] = []

    if (input.title !== undefined) {
      sets.push('title = ?')
      params.push(input.title)
    }
    if (input.status !== undefined) {
      sets.push('status = ?')
      params.push(input.status)
    }
    if (input.decisionSummary !== undefined) {
      sets.push('decision_summary = ?')
      params.push(input.decisionSummary)
    }
    if (input.decidedAt !== undefined) {
      sets.push('decided_at = ?')
      params.push(input.decidedAt)
    }
    if (input.closedAt !== undefined) {
      sets.push('closed_at = ?')
      params.push(input.closedAt)
    }

    if (sets.length === 0) return this.requireGet(id)

    params.push(id)
    this.db
      .prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?`)
      .run(...(params as (string | number | null)[]))
    return this.requireGet(id)
  }

  get(id: string): Conversation | null {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? rowToConversation(row) : null
  }

  findByProject(projectId: string, status?: ConversationStatus): Conversation[] {
    const rows = status
      ? (this.db
          .prepare(
            'SELECT * FROM conversations WHERE project_id = ? AND status = ? ORDER BY created_at DESC'
          )
          .all(projectId, status) as Array<Record<string, unknown>>)
      : (this.db
          .prepare('SELECT * FROM conversations WHERE project_id = ? ORDER BY created_at DESC')
          .all(projectId) as Array<Record<string, unknown>>)
    return rows.map(rowToConversation)
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM conversation_actions WHERE conversation_id = ?').run(id)
    this.db.prepare('DELETE FROM conversation_links WHERE conversation_id = ?').run(id)
    this.db.prepare('DELETE FROM conversation_messages WHERE conversation_id = ?').run(id)
    this.db.prepare('DELETE FROM conversation_participants WHERE conversation_id = ?').run(id)
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
  }

  private requireGet(id: string): Conversation {
    const c = this.get(id)
    if (!c) throw new Error(`Conversation not found: ${id}`)
    return c
  }

  // ── Participants ───────────────────────────────────────────────────────────

  addParticipant(
    conversationId: string,
    name: string,
    type: ConversationParticipantType,
    role?: string | null
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO conversation_participants
       (conversation_id, participant_name, participant_type, participant_role)
       VALUES (?, ?, ?, ?)`
      )
      .run(conversationId, name, type, role ?? null)
  }

  removeParticipant(conversationId: string, name: string): void {
    this.db
      .prepare(
        'DELETE FROM conversation_participants WHERE conversation_id = ? AND participant_name = ?'
      )
      .run(conversationId, name)
  }

  getParticipants(conversationId: string): ConversationParticipant[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM conversation_participants WHERE conversation_id = ? ORDER BY participant_name'
      )
      .all(conversationId) as Array<Record<string, unknown>>
    return rows.map(rowToParticipant)
  }

  // ── Messages ───────────────────────────────────────────────────────────────

  addMessage(input: CreateConversationMessageInput): ConversationMessage {
    const id = input.id || generateId('MSG')
    this.db
      .prepare(
        `INSERT INTO conversation_messages
       (id, conversation_id, author_name, content, message_type, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.conversationId,
        input.authorName,
        input.content,
        input.messageType || 'comment',
        input.metadata ? JSON.stringify(input.metadata) : null
      )
    const row = this.db
      .prepare('SELECT * FROM conversation_messages WHERE id = ?')
      .get(id) as Record<string, unknown>
    return rowToMessage(row)
  }

  getMessages(conversationId: string): ConversationMessage[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at, id'
      )
      .all(conversationId) as Array<Record<string, unknown>>
    return rows.map(rowToMessage)
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  addAction(input: CreateConversationActionInput): ConversationAction {
    const id = input.id || generateId('ACT')
    this.db
      .prepare(
        `INSERT INTO conversation_actions
       (id, conversation_id, assignee, description, status, linked_task_id)
       VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.conversationId,
        input.assignee,
        input.description,
        input.status || 'pending',
        input.linkedTaskId || null
      )
    const row = this.db
      .prepare('SELECT * FROM conversation_actions WHERE id = ?')
      .get(id) as Record<string, unknown>
    return rowToAction(row)
  }

  updateAction(id: string, input: UpdateConversationActionInput): ConversationAction {
    const sets: string[] = []
    const params: Param[] = []

    if (input.status !== undefined) {
      sets.push('status = ?')
      params.push(input.status)
    }
    if (input.linkedTaskId !== undefined) {
      sets.push('linked_task_id = ?')
      params.push(input.linkedTaskId)
    }

    if (sets.length > 0) {
      params.push(id)
      this.db
        .prepare(`UPDATE conversation_actions SET ${sets.join(', ')} WHERE id = ?`)
        .run(...(params as (string | number | null)[]))
    }

    const row = this.db.prepare('SELECT * FROM conversation_actions WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    if (!row) throw new Error(`ConversationAction not found: ${id}`)
    return rowToAction(row)
  }

  getActions(conversationId: string): ConversationAction[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM conversation_actions WHERE conversation_id = ? ORDER BY created_at, id'
      )
      .all(conversationId) as Array<Record<string, unknown>>
    return rows.map(rowToAction)
  }

  // ── Links ──────────────────────────────────────────────────────────────────

  link(conversationId: string, linkedType: ConversationLinkType, linkedId: string): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO conversation_links (conversation_id, linked_type, linked_id) VALUES (?, ?, ?)'
      )
      .run(conversationId, linkedType, linkedId)
  }

  unlink(conversationId: string, linkedType: ConversationLinkType, linkedId: string): void {
    this.db
      .prepare(
        'DELETE FROM conversation_links WHERE conversation_id = ? AND linked_type = ? AND linked_id = ?'
      )
      .run(conversationId, linkedType, linkedId)
  }

  getLinks(conversationId: string): ConversationLink[] {
    const rows = this.db
      .prepare('SELECT * FROM conversation_links WHERE conversation_id = ?')
      .all(conversationId) as Array<{
      conversation_id: string
      linked_type: string
      linked_id: string
    }>
    return rows.map((r) => ({
      conversationId: r.conversation_id,
      linkedType: r.linked_type as ConversationLinkType,
      linkedId: r.linked_id
    }))
  }

  findByLink(linkedType: ConversationLinkType, linkedId: string): Conversation[] {
    const rows = this.db
      .prepare(
        `SELECT c.* FROM conversations c
       JOIN conversation_links l ON l.conversation_id = c.id
       WHERE l.linked_type = ? AND l.linked_id = ?
       ORDER BY c.created_at DESC`
      )
      .all(linkedType, linkedId) as Array<Record<string, unknown>>
    return rows.map(rowToConversation)
  }
}
