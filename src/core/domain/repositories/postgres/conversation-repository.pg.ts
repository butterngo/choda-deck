// ADR-030 / 2026-05-28 narrowing — Postgres conversation repo. Was read-only;
// TASK-1136 (AC-4) restores the APPEND-ONLY write surface the remote allowlist
// needs: open (create + participants + links), add (message), and the reads
// conversation_read / conversation_list call. No mutable header CRUD — the
// header (status/decisionSummary/signedOff) is a fold over the message log,
// recomputed by the sync apply path (see recomputeHeaderPg in sync-sink.ts).

import type { Queryable } from './connection'
import { generateId } from '../shared'
import type {
  Conversation,
  ConversationAction,
  ConversationActionStatus,
  ConversationLink,
  ConversationLinkType,
  ConversationMessage,
  ConversationMessageKind,
  ConversationParticipant,
  ConversationStatus,
  CreateConversationInput,
  CreateConversationMessageInput
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
      `SELECT m.id, m.conversation_id, m.author_name, m.content, m.kind, m.created_at,
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

  // ── TASK-1136 (AC-4) append-only write + read surface for the remote allowlist ──

  async get(id: string): Promise<Conversation | null> {
    const result = await this.conn.query<ConversationDbRow>(
      `SELECT ${CONV_COLS} FROM conversations WHERE id = $1`,
      [id]
    )
    return result.rows[0] ? mapConversation(result.rows[0]) : null
  }

  async findByProject(projectId: string, status?: ConversationStatus): Promise<Conversation[]> {
    const result = status
      ? await this.conn.query<ConversationDbRow>(
          `SELECT ${CONV_COLS} FROM conversations WHERE project_id = $1 AND status = $2 ORDER BY created_at DESC`,
          [projectId, status]
        )
      : await this.conn.query<ConversationDbRow>(
          `SELECT ${CONV_COLS} FROM conversations WHERE project_id = $1 ORDER BY created_at DESC`,
          [projectId]
        )
    return result.rows.map(mapConversation)
  }

  async create(input: CreateConversationInput): Promise<Conversation> {
    const id = input.id || generateId('CONV')
    const names = (input.participants ?? []).map((p) => p.name)
    await this.conn.query(
      `INSERT INTO conversations (id, project_id, title, status, created_by, participants_json)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, input.projectId, input.title, input.status || 'open', input.createdBy, JSON.stringify(names)]
    )
    for (const name of names) {
      await this.conn.query(
        `INSERT INTO conversation_participants (conversation_id, participant_name)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [id, name]
      )
    }
    return (await this.get(id))!
  }

  async addMessage(input: CreateConversationMessageInput): Promise<ConversationMessage> {
    const id = input.id || generateId('MSG')
    const result = await this.conn.query<MessageDbRow>(
      `INSERT INTO conversation_messages (id, conversation_id, author_name, content, kind)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, conversation_id, author_name, content, kind, created_at`,
      [id, input.conversationId, input.authorName, input.content, input.kind ?? 'message']
    )
    return mapMessage({ ...result.rows[0], read_by: [] })
  }

  async getParticipants(conversationId: string): Promise<ConversationParticipant[]> {
    const result = await this.conn.query<{ participant_name: string }>(
      `SELECT participant_name FROM conversation_participants WHERE conversation_id = $1 ORDER BY participant_name`,
      [conversationId]
    )
    return result.rows.map((r) => ({ conversationId, name: r.participant_name }))
  }

  async getLinks(conversationId: string): Promise<ConversationLink[]> {
    const result = await this.conn.query<{ linked_type: string; linked_id: string }>(
      `SELECT linked_type, linked_id FROM conversation_links WHERE conversation_id = $1`,
      [conversationId]
    )
    return result.rows.map((r) => ({
      conversationId,
      linkedType: r.linked_type as ConversationLinkType,
      linkedId: r.linked_id
    }))
  }

  async link(conversationId: string, linkedType: ConversationLinkType, linkedId: string): Promise<void> {
    await this.conn.query(
      `INSERT INTO conversation_links (conversation_id, linked_type, linked_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [conversationId, linkedType, linkedId]
    )
  }

  async markRead(messageId: string, participantName: string): Promise<void> {
    await this.conn.query(
      `INSERT INTO conversation_message_reads (message_id, participant_name)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [messageId, participantName]
    )
  }
}
