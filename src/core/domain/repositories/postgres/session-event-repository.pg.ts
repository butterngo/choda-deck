// ADR-030 — Postgres sibling of SessionEventRepository.
// payload_json stays TEXT (the public contract is `string | null` — callers
// pre-stringify and may pass non-JSON content). memory_candidate is a native
// BOOLEAN so no 0/1 coercion at the boundary.

import type { PgConnection } from './connection'
import type {
  CreateSessionEventInput,
  SessionEvent,
  SessionEventType
} from '../../task-types'
import { generateId, now } from '../shared'

interface SessionEventDbRow {
  id: string
  session_id: string
  event_type: string
  payload_json: string | null
  memory_candidate: boolean
  created_at: string
}

function mapRow(row: SessionEventDbRow): SessionEvent {
  return {
    id: row.id,
    sessionId: row.session_id,
    eventType: row.event_type as SessionEventType,
    payloadJson: row.payload_json,
    memoryCandidate: row.memory_candidate,
    createdAt: row.created_at
  }
}

const SELECT_COLS = 'id, session_id, event_type, payload_json, memory_candidate, created_at'

export class PostgresSessionEventRepository {
  constructor(private readonly conn: PgConnection) {}

  async create(input: CreateSessionEventInput): Promise<SessionEvent> {
    const id = input.id || generateId('EVT')
    const ts = now()
    await this.conn.query(
      `INSERT INTO session_events
         (id, session_id, event_type, payload_json, memory_candidate, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        id,
        input.sessionId,
        input.eventType,
        input.payloadJson || null,
        input.memoryCandidate ? true : false,
        ts
      ]
    )
    const got = await this.get(id)
    if (!got) throw new Error(`SessionEvent disappeared after insert: ${id}`)
    return got
  }

  async get(id: string): Promise<SessionEvent | null> {
    const result = await this.conn.query<SessionEventDbRow>(
      `SELECT ${SELECT_COLS} FROM session_events WHERE id = $1`,
      [id]
    )
    const row = result.rows[0]
    return row ? mapRow(row) : null
  }

  async listBySession(
    sessionId: string,
    eventType?: SessionEventType
  ): Promise<SessionEvent[]> {
    const result = eventType
      ? await this.conn.query<SessionEventDbRow>(
          `SELECT ${SELECT_COLS} FROM session_events
           WHERE session_id = $1 AND event_type = $2
           ORDER BY created_at ASC`,
          [sessionId, eventType]
        )
      : await this.conn.query<SessionEventDbRow>(
          `SELECT ${SELECT_COLS} FROM session_events
           WHERE session_id = $1
           ORDER BY created_at ASC`,
          [sessionId]
        )
    return result.rows.map(mapRow)
  }

  async listMemoryCandidates(sessionId: string): Promise<SessionEvent[]> {
    const result = await this.conn.query<SessionEventDbRow>(
      `SELECT ${SELECT_COLS} FROM session_events
       WHERE session_id = $1 AND memory_candidate = TRUE
       ORDER BY created_at ASC`,
      [sessionId]
    )
    return result.rows.map(mapRow)
  }
}
