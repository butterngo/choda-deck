import type Database from 'better-sqlite3'

export interface WorkspaceRow {
  id: string
  projectId: string
  label: string
  cwd: string
  archivedAt: string | null
}

export interface WorkspaceReferenceCounts {
  sessions: number
}

export class WorkspaceRepository {
  constructor(private readonly db: Database.Database) {}

  add(projectId: string, id: string, label: string, cwd: string): WorkspaceRow {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO workspaces (id, project_id, label, cwd, archived_at) VALUES (?, ?, ?, ?, NULL)'
      )
      .run(id, projectId, label, cwd)
    return { id, projectId, label, cwd, archivedAt: null }
  }

  get(id: string): WorkspaceRow | null {
    const row = this.db
      .prepare('SELECT id, project_id, label, cwd, archived_at FROM workspaces WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined
    if (!row) return null
    return mapRow(row)
  }

  findByProject(projectId: string, includeArchived = false): WorkspaceRow[] {
    const sql = includeArchived
      ? 'SELECT id, project_id, label, cwd, archived_at FROM workspaces WHERE project_id = ? ORDER BY label'
      : 'SELECT id, project_id, label, cwd, archived_at FROM workspaces WHERE project_id = ? AND archived_at IS NULL ORDER BY label'
    const rows = this.db.prepare(sql).all(projectId) as Array<Record<string, unknown>>
    return rows.map(mapRow)
  }

  archive(id: string): WorkspaceRow | null {
    const existing = this.get(id)
    if (!existing) return null
    if (existing.archivedAt) return existing
    const now = new Date().toISOString()
    this.db.prepare('UPDATE workspaces SET archived_at = ? WHERE id = ?').run(now, id)
    return { ...existing, archivedAt: now }
  }

  unarchive(id: string): WorkspaceRow | null {
    const existing = this.get(id)
    if (!existing) return null
    if (!existing.archivedAt) return existing
    this.db.prepare('UPDATE workspaces SET archived_at = NULL WHERE id = ?').run(id)
    return { ...existing, archivedAt: null }
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id)
  }

  countReferences(id: string): WorkspaceReferenceCounts {
    const sessions = (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM sessions WHERE workspace_id = ?')
        .get(id) as { n: number }
    ).n
    return { sessions }
  }
}

function mapRow(row: Record<string, unknown>): WorkspaceRow {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    label: row.label as string,
    cwd: row.cwd as string,
    archivedAt: (row.archived_at as string | null) ?? null
  }
}
