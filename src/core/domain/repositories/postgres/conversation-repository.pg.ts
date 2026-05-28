// ADR-030 / 2026-05-28 narrowing — Postgres conversation repo, read-only.
//
// Kept: findByLink (inbox_get + task_context linked-conv lookups), getMessages
// (inbox_get message list), getActions (task_context per-conv action display).
// Writes, participants, links/unlinks, deletes, and the role-routed event
// emitter are gone — no remote tool can post to or restructure a conversation.

import type { Queryable } from './connection'
import type {
  Conversation,
  ConversationAction,
  ConversationActionStatus,
  ConversationLinkType,
  ConversationMessage,
  ConversationMessageMetadata,
  ConversationMessageType,
  ConversationStatus
} from '../../task-types'

interface ConversationDbRow {
  id: string
  project_id: string
  title: string
  status: string
  created_by: string
  decision_summary: string | null
  created_at: Date
  decided_at: string | null
  closed_at: string | null
}

function mapConversation(row: ConversationDbRow): Conversation {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    status: row.status as ConversationStatus,
    createdBy: row.created_by,
    decisionSummary: row.decision_summary,
    createdAt: row.created_at.toISOString(),
    decidedAt: row.decided_at,
    closedAt: row.closed_at
  }
}

interface MessageDbRow {
  id: string
  conversation_id: string
  author_name: string
  content: string
  message_type: string
  metadata_json: ConversationMessageMetadata | null
  target_role: string | null
  created_at: Date
}

function mapMessage(row: MessageDbRow): ConversationMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    authorName: row.author_name,
    content: row.content,
    messageType: row.message_type as ConversationMessageType,
    metadata: row.metadata_json,
    targetRole: row.target_role,
    createdAt: row.created_at.toISOString()
  }
}

interface ActionDbRow {
  id: string
  conversation_id: string
  assignee: string
  description: string
  status: string
  linked_task_id: string | null
  created_at: Date
}

function mapAction(row: ActionDbRow): ConversationAction {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    assignee: row.assignee,
    description: row.description,
    status: row.status as ConversationActionStatus,
    linkedTaskId: row.linked_task_id,
    createdAt: row.created_at.toISOString()
  }
}

const CONV_COLS =
  'id, project_id, title, status, created_by, decision_summary, created_at, decided_at, closed_at'
const MESSAGE_COLS =
  'id, conversation_id, author_name, content, message_type, metadata_json, target_role, created_at'
const ACTION_COLS =
  'id, conversation_id, assignee, description, status, linked_task_id, created_at'

export class PostgresConversationRepository {
  constructor(private readonly conn: Queryable) {}

  async findByLink(
    linkedType: ConversationLinkType,
    linkedId: string
  ): Promise<Conversation[]> {
    const result = await this.conn.query<ConversationDbRow>(
      `SELECT ${CONV_COLS.split(', ')
        .map((c) => `c.${c}`)
        .join(', ')}
       FROM conversations c
       JOIN conversation_links l ON l.conversation_id = c.id
       WHERE l.linked_type = $1 AND l.linked_id = $2
       ORDER BY c.created_at DESC`,
      [linkedType, linkedId]
    )
    return result.rows.map(mapConversation)
  }

  async getMessages(conversationId: string): Promise<ConversationMessage[]> {
    const result = await this.conn.query<MessageDbRow>(
      `SELECT ${MESSAGE_COLS} FROM conversation_messages
       WHERE conversation_id = $1 ORDER BY created_at, id`,
      [conversationId]
    )
    return result.rows.map(mapMessage)
  }

  async getActions(conversationId: string): Promise<ConversationAction[]> {
    const result = await this.conn.query<ActionDbRow>(
      `SELECT ${ACTION_COLS} FROM conversation_actions
       WHERE conversation_id = $1 ORDER BY created_at, id`,
      [conversationId]
    )
    return result.rows.map(mapAction)
  }
}
