// ADR-030 — Postgres sibling of SessionRepository.
//
// Schema differences vs SQLite:
//   - handoff_json + checkpoint are JSONB (node-pg auto-parses on read,
//     auto-stringifies on write when given an object literal — but we still
//     pass JSON.stringify for typed-array safety with arbitrary nested shapes)
//   - timestamps stay TEXT for round-trip parity (SQLite stores caller ISO
//     strings verbatim; tests do exact-string comparisons in places)
//
// Tie-break ordering uses `id DESC` (SESSION-* + Date.now() suffix from
// generateId is monotonic within a process) — Postgres has no rowid.

import type { PgConnection, SqlValue } from './connection'
import type {
  CreateSessionInput,
  Session,
  SessionCheckpoint,
  SessionHandoff,
  SessionStatus,
  UpdateSessionInput
} from '../../task-types'
import { generateId, now } from '../shared'

interface SessionDbRow {
  id: string
  project_id: string
  workspace_id: string | null
  task_id: string | null
  started_at: string
  ended_at: string | null
  status: string
  handoff_json: SessionHandoff | null
  checkpoint: SessionCheckpoint | null
  checkpoint_at: string | null
  created_at: string
}

function mapRow(row: SessionDbRow): Session {
  return {
    id: row.id,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    taskId: row.task_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    status: row.status as SessionStatus,
    handoff: row.handoff_json,
    checkpoint: row.checkpoint,
    checkpointAt: row.checkpoint_at,
    createdAt: row.created_at
  }
}

const SELECT_COLS =
  'id, project_id, workspace_id, task_id, started_at, ended_at, status, handoff_json, checkpoint, checkpoint_at, created_at'

export class PostgresSessionRepository {
  constructor(private readonly conn: PgConnection) {}

  async create(input: CreateSessionInput): Promise<Session> {
    const ts = now()
    const id = input.id || generateId('SESSION')
    const startedAt = input.startedAt || ts
    await this.conn.query(
      `INSERT INTO sessions (id, project_id, workspace_id, task_id, started_at, status, handoff_json, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [
        id,
        input.projectId,
        input.workspaceId || null,
        input.taskId || null,
        startedAt,
        input.status || 'active',
        input.handoff ? JSON.stringify(input.handoff) : null,
        ts
      ]
    )
    const created = await this.get(id)
    if (!created) throw new Error(`Session disappeared after insert: ${id}`)
    return created
  }

  async update(id: string, input: UpdateSessionInput): Promise<Session> {
    const sets: string[] = []
    const params: SqlValue[] = []
    let n = 1

    if (input.endedAt !== undefined) {
      sets.push(`ended_at = $${n++}`)
      params.push(input.endedAt)
    }
    if (input.status !== undefined) {
      sets.push(`status = $${n++}`)
      params.push(input.status)
    }
    if (input.taskId !== undefined) {
      sets.push(`task_id = $${n++}`)
      params.push(input.taskId)
    }
    if (input.handoff !== undefined) {
      sets.push(`handoff_json = $${n++}::jsonb`)
      params.push(input.handoff === null ? null : JSON.stringify(input.handoff))
    }
    if (input.checkpoint !== undefined) {
      sets.push(`checkpoint = $${n++}::jsonb`)
      params.push(input.checkpoint === null ? null : JSON.stringify(input.checkpoint))
    }
    if (input.checkpointAt !== undefined) {
      sets.push(`checkpoint_at = $${n++}`)
      params.push(input.checkpointAt)
    }

    if (sets.length === 0) {
      const s = await this.get(id)
      if (!s) throw new Error(`Session not found: ${id}`)
      return s
    }

    params.push(id)
    await this.conn.query(`UPDATE sessions SET ${sets.join(', ')} WHERE id = $${n}`, params)
    const s = await this.get(id)
    if (!s) throw new Error(`Session not found: ${id}`)
    return s
  }

  async get(id: string): Promise<Session | null> {
    const result = await this.conn.query<SessionDbRow>(
      `SELECT ${SELECT_COLS} FROM sessions WHERE id = $1`,
      [id]
    )
    const row = result.rows[0]
    return row ? mapRow(row) : null
  }

  async findByProject(projectId: string, status?: SessionStatus): Promise<Session[]> {
    const result = status
      ? await this.conn.query<SessionDbRow>(
          `SELECT ${SELECT_COLS} FROM sessions
           WHERE project_id = $1 AND status = $2
           ORDER BY started_at DESC, id DESC`,
          [projectId, status]
        )
      : await this.conn.query<SessionDbRow>(
          `SELECT ${SELECT_COLS} FROM sessions
           WHERE project_id = $1
           ORDER BY started_at DESC, id DESC`,
          [projectId]
        )
    return result.rows.map(mapRow)
  }

  async findActiveByTask(taskId: string): Promise<Session[]> {
    const result = await this.conn.query<SessionDbRow>(
      `SELECT ${SELECT_COLS} FROM sessions
       WHERE task_id = $1 AND status = 'active'
       ORDER BY started_at DESC, id DESC`,
      [taskId]
    )
    return result.rows.map(mapRow)
  }

  async getActive(projectId: string, workspaceId?: string): Promise<Session | null> {
    const result = workspaceId
      ? await this.conn.query<SessionDbRow>(
          `SELECT ${SELECT_COLS} FROM sessions
           WHERE project_id = $1 AND workspace_id = $2 AND status = 'active'
           ORDER BY started_at DESC, id DESC LIMIT 1`,
          [projectId, workspaceId]
        )
      : await this.conn.query<SessionDbRow>(
          `SELECT ${SELECT_COLS} FROM sessions
           WHERE project_id = $1 AND status = 'active'
           ORDER BY started_at DESC, id DESC LIMIT 1`,
          [projectId]
        )
    const row = result.rows[0]
    return row ? mapRow(row) : null
  }

  async delete(id: string): Promise<void> {
    await this.conn.query('DELETE FROM sessions WHERE id = $1', [id])
  }
}
