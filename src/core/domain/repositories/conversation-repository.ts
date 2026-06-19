import type Database from 'better-sqlite3'
import type {
  Conversation,
  ConversationStatus,
  ConversationMessage,
  ConversationMessageKind,
  ConversationLink,
  ConversationLinkType,
  ConversationParticipant,
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
  const signedOff = parseSignedOff(row.signed_off_json)
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    title: row.title as string,
    status: row.status as ConversationStatus,
    createdBy: row.created_by as string,
    decisionSummary: (row.decision_summary as string) || null,
    signedOff,
    createdAt: row.created_at as string,
    decidedAt: (row.decided_at as string) || null
  }
}

function parseSignedOff(raw: unknown): string[] {
  if (raw == null) return []
  if (typeof raw !== 'string' || raw.length === 0) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function rowToParticipant(row: Record<string, unknown>): ConversationParticipant {
  return {
    conversationId: row.conversation_id as string,
    name: row.participant_name as string
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
        this.addParticipant(id, p.name)
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
            'SELECT * FROM conversations WHERE project_id = ? AND status = ? ORDER BY created_at DESC, rowid DESC'
          )
          .all(projectId, status) as Array<Record<string, unknown>>)
      : (this.db
          .prepare('SELECT * FROM conversations WHERE project_id = ? ORDER BY created_at DESC, rowid DESC')
          .all(projectId) as Array<Record<string, unknown>>)
    return rows.map(rowToConversation)
  }

  delete(id: string): void {
    this.db
      .prepare(
        'DELETE FROM conversation_message_reads WHERE message_id IN (SELECT id FROM conversation_messages WHERE conversation_id = ?)'
      )
      .run(id)
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

  addParticipant(conversationId: string, name: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO conversation_participants (conversation_id, participant_name) VALUES (?, ?)`
      )
      .run(conversationId, name)
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
        'SELECT conversation_id, participant_name FROM conversation_participants WHERE conversation_id = ? ORDER BY participant_name'
      )
      .all(conversationId) as Array<Record<string, unknown>>
    return rows.map(rowToParticipant)
  }

  // ── Signoff (TASK-972) ─────────────────────────────────────────────────────

  appendSignoff(conversationId: string, name: string): string[] {
    const conv = this.get(conversationId)
    if (!conv) throw new Error(`Conversation not found: ${conversationId}`)
    if (conv.signedOff.includes(name)) return conv.signedOff
    const next = [...conv.signedOff, name]
    this.db
      .prepare('UPDATE conversations SET signed_off_json = ? WHERE id = ?')
      .run(JSON.stringify(next), conversationId)
    return next
  }

  // ── Messages ───────────────────────────────────────────────────────────────

  addMessage(input: CreateConversationMessageInput): ConversationMessage {
    const id = input.id || generateId('MSG')
    this.db
      .prepare(
        `INSERT INTO conversation_messages (id, conversation_id, author_name, content, kind)
       VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, input.conversationId, input.authorName, input.content, input.kind ?? 'message')
    const row = this.db
      .prepare('SELECT * FROM conversation_messages WHERE id = ?')
      .get(id) as Record<string, unknown>
    return {
      id: row.id as string,
      conversationId: row.conversation_id as string,
      authorName: row.author_name as string,
      content: row.content as string,
      kind: (row.kind as ConversationMessageKind) ?? 'message',
      readBy: [],
      createdAt: row.created_at as string
    }
  }

  // TASK-1067 — fold the append-only message log into the conversation header
  // (status / decisionSummary / signedOff / decidedAt) and write it to the cache
  // columns. Pure function of the messages + participants, so re-running it on
  // any node after a sync merge converges the header regardless of LWW on the
  // (non-authoritative) header columns. Call after any message append/merge.
  recomputeHeader(conversationId: string): void {
    const conv = this.get(conversationId)
    if (!conv) return
    const msgs = this.getMessages(conversationId)
    const decisions = msgs.filter((m) => m.kind === 'decision')
    const lastDecision = decisions.length > 0 ? decisions[decisions.length - 1] : null
    const signoffs = msgs.filter((m) => m.kind === 'signoff')
    const signedOff = [...new Set(signoffs.map((m) => m.authorName))]

    const participants = this.getParticipants(conversationId).map((p) => p.name)
    const consensus =
      lastDecision != null &&
      (participants.length === 0 || participants.every((p) => signedOff.includes(p)))

    // decidedAt = when consensus was reached: the later of the decision turn and
    // the last signoff that completed it. Deterministic from message timestamps.
    let decidedAt: string | null = null
    if (consensus) {
      const completing = [lastDecision.createdAt, ...signoffs.map((m) => m.createdAt)]
      decidedAt = completing.sort()[completing.length - 1]
    }

    this.db
      .prepare(
        'UPDATE conversations SET status = ?, decision_summary = ?, signed_off_json = ?, decided_at = ? WHERE id = ?'
      )
      .run(
        consensus ? 'decided' : 'open',
        lastDecision ? lastDecision.content : null,
        JSON.stringify(signedOff),
        decidedAt,
        conversationId
      )
  }

  markMessageRead(messageId: string, participantName: string): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO conversation_message_reads (message_id, participant_name) VALUES (?, ?)'
      )
      .run(messageId, participantName)
  }

  getMessages(conversationId: string): ConversationMessage[] {
    const rows = this.db
      .prepare(
        `SELECT m.id, m.conversation_id, m.author_name, m.content, m.kind, m.created_at,
                GROUP_CONCAT(r.participant_name) AS read_by_csv
         FROM conversation_messages m
         LEFT JOIN conversation_message_reads r ON r.message_id = m.id
         WHERE m.conversation_id = ?
         GROUP BY m.id
         ORDER BY m.created_at, m.id`
      )
      .all(conversationId) as Array<Record<string, unknown>>
    return rows.map((row) => ({
      id: row.id as string,
      conversationId: row.conversation_id as string,
      authorName: row.author_name as string,
      content: row.content as string,
      kind: (row.kind as ConversationMessageKind) ?? 'message',
      readBy: parseReadByCsv(row.read_by_csv),
      createdAt: row.created_at as string
    }))
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

function parseReadByCsv(raw: unknown): string[] {
  if (raw == null || typeof raw !== 'string' || raw.length === 0) return []
  return raw.split(',').filter((s) => s.length > 0)
}
