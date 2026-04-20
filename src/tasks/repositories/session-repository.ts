import type Database from 'better-sqlite3'
import type {
  Session,
  SessionCheckpoint,
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
    workspaceId: (row.workspace_id as string) || null,
    taskId: (row.task_id as string) || null,
    startedAt: row.started_at as string,
    endedAt: (row.ended_at as string) || null,
    status: row.status as SessionStatus,
    handoff: row.handoff_json ? (JSON.parse(row.handoff_json as string) as SessionHandoff) : null,
    checkpoint: row.checkpoint
      ? (JSON.parse(row.checkpoint as string) as SessionCheckpoint)
      : null,
    checkpointAt: (row.checkpoint_at as string) || null,
    createdAt: row.created_at as string
  }
}

export class SessionRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: CreateSessionInput): Session {
    const ts = now()
    const id = input.id || generateId('SESSION')
    const startedAt = input.startedAt || ts
    this.db
      .prepare(
        `INSERT INTO sessions (id, project_id, workspace_id, task_id, started_at, status, handoff_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.projectId,
        input.workspaceId || null,
        input.taskId || null,
        startedAt,
        input.status || 'active',
        input.handoff ? JSON.stringify(input.handoff) : null,
        ts
      )
    return this.get(id)!
  }

  update(id: string, input: UpdateSessionInput): Session {
    const sets: string[] = []
    const params: Param[] = []

    if (input.endedAt !== undefined) {
      sets.push('ended_at = ?')
      params.push(input.endedAt)
    }
    if (input.status !== undefined) {
      sets.push('status = ?')
      params.push(input.status)
    }
    if (input.taskId !== undefined) {
      sets.push('task_id = ?')
      params.push(input.taskId)
    }
    if (input.handoff !== undefined) {
      sets.push('handoff_json = ?')
      params.push(input.handoff === null ? null : JSON.stringify(input.handoff))
    }
    if (input.checkpoint !== undefined) {
      sets.push('checkpoint = ?')
      params.push(input.checkpoint === null ? null : JSON.stringify(input.checkpoint))
    }
    if (input.checkpointAt !== undefined) {
      sets.push('checkpoint_at = ?')
      params.push(input.checkpointAt)
    }

    if (sets.length === 0) {
      const s = this.get(id)
      if (!s) throw new Error(`Session not found: ${id}`)
      return s
    }

    params.push(id)
    this.db
      .prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`)
      .run(...(params as (string | number | null)[]))
    const s = this.get(id)
    if (!s) throw new Error(`Session not found: ${id}`)
    return s
  }

  get(id: string): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? rowToSession(row) : null
  }

  findByProject(projectId: string, status?: SessionStatus): Session[] {
    const rows = status
      ? (this.db
          .prepare(
            'SELECT * FROM sessions WHERE project_id = ? AND status = ? ORDER BY started_at DESC'
          )
          .all(projectId, status) as Array<Record<string, unknown>>)
      : (this.db
          .prepare('SELECT * FROM sessions WHERE project_id = ? ORDER BY started_at DESC')
          .all(projectId) as Array<Record<string, unknown>>)
    return rows.map(rowToSession)
  }

  getActive(projectId: string, workspaceId?: string): Session | null {
    const sql = workspaceId
      ? "SELECT * FROM sessions WHERE project_id = ? AND workspace_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1"
      : "SELECT * FROM sessions WHERE project_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1"
    const params = workspaceId ? [projectId, workspaceId] : [projectId]
    const row = this.db.prepare(sql).get(...params) as Record<string, unknown> | undefined
    return row ? rowToSession(row) : null
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  }
}
