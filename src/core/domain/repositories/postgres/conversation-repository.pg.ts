// ADR-030 — Postgres sibling of ConversationRepository. The largest of the
// M1 cluster: 5 tables, role-routed event fanout (ADR-021 Phase 3), and a
// delete that cascades through 4 child tables in a single transaction.
//
// Schema notes:
//   - created_at is TIMESTAMPTZ DEFAULT NOW() (mapped to ISO at boundary).
//     The SQLite side stored `YYYY-MM-DD HH:MM:SS` and normalizeEventTimestamp
//     coerced to ISO at the emit boundary — here the value is already ISO.
//   - metadata_json on messages is JSONB; node-pg auto-parses on read.
//   - INSERT OR REPLACE for participants is realized as ON CONFLICT DO UPDATE.
//
// Event fanout is reused unchanged from services/event-emitter — that module
// is db-agnostic (JSONL files). The only db work in the fanout path is the
// project-existence check, ported to `$1` parameter style.

import { runInTx, type Queryable, type SqlValue } from './connection'
import type {
  Conversation,
  ConversationAction,
  ConversationActionStatus,
  ConversationLink,
  ConversationLinkType,
  ConversationMessage,
  ConversationMessageMetadata,
  ConversationMessageType,
  ConversationParticipant,
  ConversationParticipantType,
  ConversationStatus,
  CreateConversationActionInput,
  CreateConversationInput,
  CreateConversationMessageInput,
  UpdateConversationActionInput,
  UpdateConversationInput
} from '../../task-types'
import {
  emitConversationEventFanout,
  type ConversationEventType
} from '../../services/event-emitter'
import { generateId } from '../shared'

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

interface ParticipantDbRow {
  conversation_id: string
  participant_name: string
  participant_type: string
  participant_role: string | null
}

function mapParticipant(row: ParticipantDbRow): ConversationParticipant {
  return {
    conversationId: row.conversation_id,
    name: row.participant_name,
    type: row.participant_type as ConversationParticipantType,
    role: row.participant_role
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
const PARTICIPANT_COLS =
  'conversation_id, participant_name, participant_type, participant_role'
const MESSAGE_COLS =
  'id, conversation_id, author_name, content, message_type, metadata_json, target_role, created_at'
const ACTION_COLS =
  'id, conversation_id, assignee, description, status, linked_task_id, created_at'

export class PostgresConversationRepository {
  constructor(private readonly conn: Queryable) {}

  // ── Conversations ──────────────────────────────────────────────────────────

  async create(input: CreateConversationInput): Promise<Conversation> {
    const id = input.id || generateId('CONV')
    await this.conn.query(
      `INSERT INTO conversations (id, project_id, title, status, created_by, owner_type, owner_session_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        input.projectId,
        input.title,
        input.status || 'open',
        input.createdBy,
        input.ownerType ?? null,
        input.ownerSessionId ?? null
      ]
    )

    if (input.participants) {
      for (const p of input.participants) {
        await this.addParticipant(id, p.name, p.type, p.role)
      }
    }

    const got = await this.get(id)
    if (!got) throw new Error(`Conversation disappeared after insert: ${id}`)
    return got
  }

  async update(id: string, input: UpdateConversationInput): Promise<Conversation> {
    const sets: string[] = []
    const params: SqlValue[] = []
    let n = 1

    if (input.title !== undefined) {
      sets.push(`title = $${n++}`)
      params.push(input.title)
    }
    if (input.status !== undefined) {
      sets.push(`status = $${n++}`)
      params.push(input.status)
    }
    if (input.decisionSummary !== undefined) {
      sets.push(`decision_summary = $${n++}`)
      params.push(input.decisionSummary)
    }
    if (input.decidedAt !== undefined) {
      sets.push(`decided_at = $${n++}`)
      params.push(input.decidedAt)
    }
    if (input.closedAt !== undefined) {
      sets.push(`closed_at = $${n++}`)
      params.push(input.closedAt)
    }

    if (sets.length === 0) return this.requireGet(id)

    params.push(id)
    await this.conn.query(
      `UPDATE conversations SET ${sets.join(', ')} WHERE id = $${n}`,
      params
    )
    return this.requireGet(id)
  }

  async get(id: string): Promise<Conversation | null> {
    const result = await this.conn.query<ConversationDbRow>(
      `SELECT ${CONV_COLS} FROM conversations WHERE id = $1`,
      [id]
    )
    const row = result.rows[0]
    return row ? mapConversation(row) : null
  }

  async findByProject(projectId: string, status?: ConversationStatus): Promise<Conversation[]> {
    const result = status
      ? await this.conn.query<ConversationDbRow>(
          `SELECT ${CONV_COLS} FROM conversations
           WHERE project_id = $1 AND status = $2
           ORDER BY created_at DESC, id DESC`,
          [projectId, status]
        )
      : await this.conn.query<ConversationDbRow>(
          `SELECT ${CONV_COLS} FROM conversations
           WHERE project_id = $1
           ORDER BY created_at DESC, id DESC`,
          [projectId]
        )
    return result.rows.map(mapConversation)
  }

  async delete(id: string): Promise<void> {
    await runInTx(this.conn, async (tx) => {
      await tx.query('DELETE FROM conversation_actions WHERE conversation_id = $1', [id])
      await tx.query('DELETE FROM conversation_links WHERE conversation_id = $1', [id])
      await tx.query('DELETE FROM conversation_messages WHERE conversation_id = $1', [id])
      await tx.query('DELETE FROM conversation_participants WHERE conversation_id = $1', [id])
      await tx.query('DELETE FROM conversations WHERE id = $1', [id])
    })
  }

  private async requireGet(id: string): Promise<Conversation> {
    const c = await this.get(id)
    if (!c) throw new Error(`Conversation not found: ${id}`)
    return c
  }

  // ── Participants ───────────────────────────────────────────────────────────

  async addParticipant(
    conversationId: string,
    name: string,
    type: ConversationParticipantType,
    role?: string | null
  ): Promise<void> {
    await this.conn.query(
      `INSERT INTO conversation_participants
         (conversation_id, participant_name, participant_type, participant_role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (conversation_id, participant_name) DO UPDATE SET
         participant_type = EXCLUDED.participant_type,
         participant_role = EXCLUDED.participant_role`,
      [conversationId, name, type, role ?? null]
    )
  }

  async removeParticipant(conversationId: string, name: string): Promise<void> {
    await this.conn.query(
      'DELETE FROM conversation_participants WHERE conversation_id = $1 AND participant_name = $2',
      [conversationId, name]
    )
  }

  async getParticipants(conversationId: string): Promise<ConversationParticipant[]> {
    const result = await this.conn.query<ParticipantDbRow>(
      `SELECT ${PARTICIPANT_COLS} FROM conversation_participants
       WHERE conversation_id = $1 ORDER BY participant_name`,
      [conversationId]
    )
    return result.rows.map(mapParticipant)
  }

  // ── Messages ───────────────────────────────────────────────────────────────

  async addMessage(input: CreateConversationMessageInput): Promise<ConversationMessage> {
    const id = input.id || generateId('MSG')
    const result = await this.conn.query<MessageDbRow>(
      `INSERT INTO conversation_messages
         (id, conversation_id, author_name, content, message_type, metadata_json, target_role)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       RETURNING ${MESSAGE_COLS}`,
      [
        id,
        input.conversationId,
        input.authorName,
        input.content,
        input.messageType || 'comment',
        input.metadata ? JSON.stringify(input.metadata) : null,
        input.targetRole ?? null
      ]
    )
    const message = mapMessage(result.rows[0])
    await this.emitMessageEventIfRoleRouted(message)
    return message
  }

  private async emitMessageEventIfRoleRouted(message: ConversationMessage): Promise<void> {
    const eventType: ConversationEventType | null =
      message.messageType === 'question'
        ? 'message.question'
        : message.messageType === 'answer'
          ? 'message.answer'
          : null
    if (!eventType) return
    await this.emitWithRoleFilter(
      message.conversationId,
      eventType,
      message.messageType,
      message.authorName,
      message.createdAt,
      message.targetRole
    )
  }

  async emitLifecycleEvent(
    conversationId: string,
    type: ConversationEventType,
    author: string,
    timestamp: string
  ): Promise<void> {
    await this.emitWithRoleFilter(conversationId, type, type, author, timestamp, null)
  }

  private async emitWithRoleFilter(
    conversationId: string,
    type: ConversationEventType,
    messageType: string,
    author: string,
    timestamp: string,
    targetRole: string | null
  ): Promise<void> {
    const conv = await this.get(conversationId)
    if (!conv) return
    const participants = await this.getParticipants(conversationId)
    const allRoles = participants.map((p) => p.role).filter((r): r is string => !!r)
    let roles: string[]
    if (targetRole !== null) {
      if (!allRoles.includes(targetRole)) return
      roles = [targetRole]
    } else {
      if (allRoles.length === 0) return
      roles = allRoles
    }
    const targetProjectIds = await this.resolveFanoutTargets(roles, conv.projectId)
    emitConversationEventFanout(conv.projectId, targetProjectIds, {
      type,
      conversationId,
      roles,
      messageType,
      author,
      timestamp
    })
  }

  // ADR-021 Phase 3: parse "<projectId>/<workspaceId>" addresses, return the
  // unique validated set of fan-out target projectIds (owner excluded).
  // Unknown projectIds are logged and skipped — never throw.
  private async resolveFanoutTargets(
    roles: string[],
    ownerProjectId: string
  ): Promise<string[]> {
    const candidates = new Set<string>()
    for (const role of roles) {
      const slash = role.indexOf('/')
      if (slash <= 0) continue
      const projectId = role.slice(0, slash)
      if (projectId === ownerProjectId) continue
      candidates.add(projectId)
    }
    if (candidates.size === 0) return []
    const targets: string[] = []
    for (const projectId of candidates) {
      const r = await this.conn.query('SELECT 1 FROM projects WHERE id = $1', [projectId])
      if (r.rows.length > 0) {
        targets.push(projectId)
      } else {
        console.warn(
          `[conversation-event-emitter] unknown target projectId in role address: ${projectId}`
        )
      }
    }
    return targets
  }

  async getMessages(conversationId: string): Promise<ConversationMessage[]> {
    const result = await this.conn.query<MessageDbRow>(
      `SELECT ${MESSAGE_COLS} FROM conversation_messages
       WHERE conversation_id = $1 ORDER BY created_at, id`,
      [conversationId]
    )
    return result.rows.map(mapMessage)
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  async addAction(input: CreateConversationActionInput): Promise<ConversationAction> {
    const id = input.id || generateId('ACT')
    const result = await this.conn.query<ActionDbRow>(
      `INSERT INTO conversation_actions
         (id, conversation_id, assignee, description, status, linked_task_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${ACTION_COLS}`,
      [
        id,
        input.conversationId,
        input.assignee,
        input.description,
        input.status || 'pending',
        input.linkedTaskId || null
      ]
    )
    return mapAction(result.rows[0])
  }

  async updateAction(
    id: string,
    input: UpdateConversationActionInput
  ): Promise<ConversationAction> {
    const sets: string[] = []
    const params: SqlValue[] = []
    let n = 1

    if (input.status !== undefined) {
      sets.push(`status = $${n++}`)
      params.push(input.status)
    }
    if (input.linkedTaskId !== undefined) {
      sets.push(`linked_task_id = $${n++}`)
      params.push(input.linkedTaskId)
    }

    if (sets.length > 0) {
      params.push(id)
      await this.conn.query(
        `UPDATE conversation_actions SET ${sets.join(', ')} WHERE id = $${n}`,
        params
      )
    }

    const result = await this.conn.query<ActionDbRow>(
      `SELECT ${ACTION_COLS} FROM conversation_actions WHERE id = $1`,
      [id]
    )
    const row = result.rows[0]
    if (!row) throw new Error(`ConversationAction not found: ${id}`)
    return mapAction(row)
  }

  async getActions(conversationId: string): Promise<ConversationAction[]> {
    const result = await this.conn.query<ActionDbRow>(
      `SELECT ${ACTION_COLS} FROM conversation_actions
       WHERE conversation_id = $1 ORDER BY created_at, id`,
      [conversationId]
    )
    return result.rows.map(mapAction)
  }

  // ── Links ──────────────────────────────────────────────────────────────────

  async link(
    conversationId: string,
    linkedType: ConversationLinkType,
    linkedId: string
  ): Promise<void> {
    await this.conn.query(
      `INSERT INTO conversation_links (conversation_id, linked_type, linked_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (conversation_id, linked_type, linked_id) DO NOTHING`,
      [conversationId, linkedType, linkedId]
    )
  }

  async unlink(
    conversationId: string,
    linkedType: ConversationLinkType,
    linkedId: string
  ): Promise<void> {
    await this.conn.query(
      'DELETE FROM conversation_links WHERE conversation_id = $1 AND linked_type = $2 AND linked_id = $3',
      [conversationId, linkedType, linkedId]
    )
  }

  async getLinks(conversationId: string): Promise<ConversationLink[]> {
    const result = await this.conn.query<{
      conversation_id: string
      linked_type: string
      linked_id: string
    }>(
      'SELECT conversation_id, linked_type, linked_id FROM conversation_links WHERE conversation_id = $1',
      [conversationId]
    )
    return result.rows.map((r) => ({
      conversationId: r.conversation_id,
      linkedType: r.linked_type as ConversationLinkType,
      linkedId: r.linked_id
    }))
  }

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
}
