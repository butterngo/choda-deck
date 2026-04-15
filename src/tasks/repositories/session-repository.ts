import type Database from 'better-sqlite3'
import type {
  Session,
  SessionHandoff,
  SessionStatus,
  CreateSessionInput,
  UpdateSessionInput
} from '../task-types'
import { now, generateId, type Param } from './shared'

function rowToSession(row: Record<string, unknown>): Session {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    startedAt: row.started_at as string,
    endedAt: (row.ended_at as string) || null,
    status: row.status as SessionStatus,
    handoff: row.handoff_json ? JSON.parse(row.handoff_json as string) as SessionHandoff : null,
    createdAt: row.created_at as string
  }
}

export class SessionRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: CreateSessionInput): Session {
    const ts = now()
    const id = input.id || generateId('SESSION')
    const startedAt = input.startedAt || ts
    this.db.prepare(
      `INSERT INTO sessions (id, project_id, started_at, status, handoff_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      id, input.projectId, startedAt, input.status || 'active',
      input.handoff ? JSON.stringify(input.handoff) : null, ts
    )
    return this.get(id)!
  }

  update(id: string, input: UpdateSessionInput): Session {
    const sets: string[] = []
    const params: Param[] = []

    if (input.endedAt !== undefined) { sets.push('ended_at = ?'); params.push(input.endedAt) }
    if (input.status !== undefined) { sets.push('status = ?'); params.push(input.status) }
    if (input.handoff !== undefined) {
      sets.push('handoff_json = ?')
      params.push(input.handoff === null ? null : JSON.stringify(input.handoff))
    }

    if (sets.length === 0) {
      const s = this.get(id)
      if (!s) throw new Error(`Session not found: ${id}`)
      return s
    }

    params.push(id)
    this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...params as (string | number | null)[])
    const s = this.get(id)
    if (!s) throw new Error(`Session not found: ${id}`)
    return s
  }

  get(id: string): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? rowToSession(row) : null
  }

  findByProject(projectId: string, status?: SessionStatus): Session[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM sessions WHERE project_id = ? AND status = ? ORDER BY started_at DESC').all(projectId, status) as Array<Record<string, unknown>>
      : this.db.prepare('SELECT * FROM sessions WHERE project_id = ? ORDER BY started_at DESC').all(projectId) as Array<Record<string, unknown>>
    return rows.map(rowToSession)
  }

  getActive(projectId: string): Session | null {
    const row = this.db.prepare(
      "SELECT * FROM sessions WHERE project_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1"
    ).get(projectId) as Record<string, unknown> | undefined
    return row ? rowToSession(row) : null
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  }
}
