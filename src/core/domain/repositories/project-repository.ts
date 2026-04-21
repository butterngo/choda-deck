import type Database from 'better-sqlite3'

export interface ProjectRow {
  id: string
  name: string
  cwd: string
}

export interface WorkspaceRow {
  id: string
  projectId: string
  label: string
  cwd: string
}

export class ProjectRepository {
  constructor(private readonly db: Database.Database) {}

  ensure(id: string, name: string, cwd: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO projects (id, name, cwd) VALUES (?, ?, ?)')
      .run(id, name, cwd)
  }

  get(id: string): ProjectRow | null {
    const row = this.db.prepare('SELECT id, name, cwd FROM projects WHERE id = ?').get(id) as
      | ProjectRow
      | undefined
    return row ?? null
  }

  list(): ProjectRow[] {
    return this.db.prepare('SELECT id, name, cwd FROM projects ORDER BY name').all() as ProjectRow[]
  }

  addWorkspace(projectId: string, id: string, label: string, cwd: string): WorkspaceRow {
    this.db
      .prepare('INSERT OR REPLACE INTO workspaces (id, project_id, label, cwd) VALUES (?, ?, ?, ?)')
      .run(id, projectId, label, cwd)
    return { id, projectId, label, cwd }
  }

  getWorkspace(id: string): WorkspaceRow | null {
    const row = this.db
      .prepare('SELECT id, project_id, label, cwd FROM workspaces WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      label: row.label as string,
      cwd: row.cwd as string
    }
  }

  findWorkspaces(projectId: string): WorkspaceRow[] {
    const rows = this.db
      .prepare(
        'SELECT id, project_id, label, cwd FROM workspaces WHERE project_id = ? ORDER BY label'
      )
      .all(projectId) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      id: r.id as string,
      projectId: r.project_id as string,
      label: r.label as string,
      cwd: r.cwd as string
    }))
  }
}
