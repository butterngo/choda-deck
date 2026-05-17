import type Database from 'better-sqlite3'
import type { SessionEvent, SessionEventType, CreateSessionEventInput } from '../task-types'
import { now, generateId } from './shared'

function rowToSessionEvent(row: Record<string, unknown>): SessionEvent {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    eventType: row.event_type as SessionEventType,
    payloadJson: (row.payload_json as string) || null,
    memoryCandidate: row.memory_candidate === 1,
    createdAt: row.created_at as string
  }
}

export class SessionEventRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: CreateSessionEventInput): SessionEvent {
    const id = input.id || generateId('EVT')
    const ts = now()
    this.db
      .prepare(
        `INSERT INTO session_events (id, session_id, event_type, payload_json, memory_candidate, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.sessionId,
        input.eventType,
        input.payloadJson || null,
        input.memoryCandidate ? 1 : 0,
        ts
      )
    return this.get(id)!
  }

  get(id: string): SessionEvent | null {
    const row = this.db.prepare('SELECT * FROM session_events WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? rowToSessionEvent(row) : null
  }

  listBySession(sessionId: string, eventType?: SessionEventType): SessionEvent[] {
    const rows = eventType
      ? (this.db
          .prepare(
            'SELECT * FROM session_events WHERE session_id = ? AND event_type = ? ORDER BY created_at ASC'
          )
          .all(sessionId, eventType) as Array<Record<string, unknown>>)
      : (this.db
          .prepare('SELECT * FROM session_events WHERE session_id = ? ORDER BY created_at ASC')
          .all(sessionId) as Array<Record<string, unknown>>)
    return rows.map(rowToSessionEvent)
  }
}
