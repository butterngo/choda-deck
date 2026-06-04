// ADR-030 / 2026-05-28 narrowing — Postgres workspace repo, read-only.
//
// Only the read methods needed by the HTTP remote surface are kept:
// findByProject (called by project_list to attach workspaces[]) and get (used
// internally by the stdio facade tests; harmless to keep). Writes
// (add/archive/unarchive/delete/countReferences) deleted because no remote
// tool can author/archive workspaces. countReferences also queried the
// sessions table — gone with the rest of the lifecycle layer.

import type { Queryable } from './connection'
import type { WorkspaceRow } from '../workspace-repository'

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
  constructor(private readonly conn: Queryable) {}

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
}
