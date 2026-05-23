// ADR-030 — Postgres sibling of WorkspaceRepository.
//
// `archived_at` is stored as TIMESTAMPTZ (Postgres-native) and rehydrated to
// an ISO-8601 string at the repository boundary so consumers see the same
// shape as the SQLite repo (which stores `new Date().toISOString()` directly).
//
// `countReferences` reads the `sessions` table which doesn't ship until slice 3 —
// throws explicitly until that table exists. SqliteWorkspaceRepository.countReferences
// is the SQLite contract this needs to match once unblocked.

import type { PgConnection } from './connection'
import type {
  WorkspaceReferenceCounts,
  WorkspaceRow
} from '../workspace-repository'

interface WorkspaceDbRow {
  id: string
  project_id: string
  label: string
  cwd: string
  archived_at: Date | null
}

function mapRow(row: WorkspaceDbRow): WorkspaceRow {
  return {
    id: row.id,
    projectId: row.project_id,
    label: row.label,
    cwd: row.cwd,
    archivedAt: row.archived_at ? row.archived_at.toISOString() : null
  }
}

const SELECT_COLS = 'id, project_id, label, cwd, archived_at'

export class PostgresWorkspaceRepository {
  constructor(private readonly conn: PgConnection) {}

  async add(projectId: string, id: string, label: string, cwd: string): Promise<WorkspaceRow> {
    await this.conn.query(
      `INSERT INTO workspaces (id, project_id, label, cwd, archived_at)
       VALUES ($1, $2, $3, $4, NULL)
       ON CONFLICT (id) DO UPDATE SET
         project_id = EXCLUDED.project_id,
         label = EXCLUDED.label,
         cwd = EXCLUDED.cwd,
         archived_at = NULL`,
      [id, projectId, label, cwd]
    )
    return { id, projectId, label, cwd, archivedAt: null }
  }

  async get(id: string): Promise<WorkspaceRow | null> {
    const result = await this.conn.query<WorkspaceDbRow>(
      `SELECT ${SELECT_COLS} FROM workspaces WHERE id = $1`,
      [id]
    )
    const row = result.rows[0]
    return row ? mapRow(row) : null
  }

  async findByProject(projectId: string, includeArchived = false): Promise<WorkspaceRow[]> {
    const sql = includeArchived
      ? `SELECT ${SELECT_COLS} FROM workspaces WHERE project_id = $1 ORDER BY label`
      : `SELECT ${SELECT_COLS} FROM workspaces WHERE project_id = $1 AND archived_at IS NULL ORDER BY label`
    const result = await this.conn.query<WorkspaceDbRow>(sql, [projectId])
    return result.rows.map(mapRow)
  }

  async archive(id: string): Promise<WorkspaceRow | null> {
    const existing = await this.get(id)
    if (!existing) return null
    if (existing.archivedAt) return existing
    const now = new Date()
    await this.conn.query('UPDATE workspaces SET archived_at = $1 WHERE id = $2', [now, id])
    return { ...existing, archivedAt: now.toISOString() }
  }

  async unarchive(id: string): Promise<WorkspaceRow | null> {
    const existing = await this.get(id)
    if (!existing) return null
    if (!existing.archivedAt) return existing
    await this.conn.query('UPDATE workspaces SET archived_at = NULL WHERE id = $1', [id])
    return { ...existing, archivedAt: null }
  }

  async delete(id: string): Promise<void> {
    await this.conn.query('DELETE FROM workspaces WHERE id = $1', [id])
  }

  async countReferences(id: string): Promise<WorkspaceReferenceCounts> {
    throw new Error(
      `PostgresWorkspaceRepository.countReferences(${id}) requires the sessions table — lands with TASK-934 slice 3`
    )
  }
}
