import type Database from 'better-sqlite3'

export interface WorkspaceRow {
  id: string
  projectId: string
  label: string
  cwd: string
}

export class WorkspaceRepository {
  constructor(private readonly db: Database.Database) {}

  add(projectId: string, id: string, label: string, cwd: string): WorkspaceRow {
    this.db
      .prepare('INSERT OR REPLACE INTO workspaces (id, project_id, label, cwd) VALUES (?, ?, ?, ?)')
      .run(id, projectId, label, cwd)
    return { id, projectId, label, cwd }
  }

  get(id: string): WorkspaceRow | null {
    const row = this.db
      .prepare('SELECT id, project_id, label, cwd FROM workspaces WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined
    if (!row) return null
    return mapRow(row)
  }

  findByProject(projectId: string): WorkspaceRow[] {
    const rows = this.db
      .prepare(
        'SELECT id, project_id, label, cwd FROM workspaces WHERE project_id = ? ORDER BY label'
      )
      .all(projectId) as Array<Record<string, unknown>>
    return rows.map(mapRow)
  }
}

function mapRow(row: Record<string, unknown>): WorkspaceRow {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    label: row.label as string,
    cwd: row.cwd as string
  }
}
