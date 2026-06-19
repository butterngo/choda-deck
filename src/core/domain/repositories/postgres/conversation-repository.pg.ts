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
  ConversationMessageKind,
  ConversationStatus
} from '../../task-types'

interface ConversationDbRow {
  id: string
  project_id: string
  title: string
  status: string
  created_by: string
  decision_summary: string | null
  signed_off_json: string | null
  created_at: Date
  decided_at: string | null
}

function mapConversation(row: ConversationDbRow): Conversation {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    status: row.status as ConversationStatus,
    createdBy: row.created_by,
    decisionSummary: row.decision_summary,
    signedOff: parseSignedOff(row.signed_off_json),
    createdAt: row.created_at.toISOString(),
    decidedAt: row.decided_at
  }
}

function parseSignedOff(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

interface MessageDbRow {
  id: string
  conversation_id: string
  author_name: string
  content: string
  // TASK-1067 — append-only fold turn type. Column lands with the PG repo
  // restoration (AC-3); default 'message' keeps pre-migration rows valid.
  kind: string | null
  read_by: string[] | null
  created_at: Date
}

function mapMessage(row: MessageDbRow): ConversationMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    authorName: row.author_name,
    content: row.content,
    kind: (row.kind ?? 'message') as ConversationMessageKind,
    readBy: row.read_by ?? [],
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
  'id, project_id, title, status, created_by, decision_summary, signed_off_json, created_at, decided_at'
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
      `SELECT m.id, m.conversation_id, m.author_name, m.content, m.created_at,
              COALESCE(array_agg(r.participant_name) FILTER (WHERE r.participant_name IS NOT NULL), '{}') AS read_by
       FROM conversation_messages m
       LEFT JOIN conversation_message_reads r ON r.message_id = m.id
       WHERE m.conversation_id = $1
       GROUP BY m.id
       ORDER BY m.created_at, m.id`,
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
