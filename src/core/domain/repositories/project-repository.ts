import type Database from 'better-sqlite3'

export interface ProjectRow {
  id: string
  name: string
  cwd: string
  // TASK-2200 — the organisation a project belongs to (ichiba, mantu, personal…).
  // Nullable: projects created before the column, or never assigned, have none.
  org: string | null
}

// TASK-2200 — every table that owns rows by project_id, apart from workspaces
// (which removal deletes with the project). A project holding any row here is
// in use and cannot be removed.
export const PROJECT_OWNED_TABLES: readonly string[] = [
  'tasks',
  'documents',
  'sessions',
  'context_sources',
  'conversations',
  'inbox_items',
  'knowledge_index',
  'code_refs'
]

export type RemoveProjectResult =
  | { removed: true; workspacesRemoved: number }
  | { removed: false; reason: 'not-found' }
  | { removed: false; reason: 'in-use'; blockers: Record<string, number> }

export class ProjectRepository {
  constructor(private readonly db: Database.Database) {}

  // Inserts when absent. `org` is the only field an existing project updates here:
  // name and cwd keep their insert-or-ignore behaviour, and an omitted org leaves
  // the stored one alone, so re-running project_add without it never clears it.
  ensure(id: string, name: string, cwd: string, org?: string | null): void {
    this.db
      .prepare('INSERT OR IGNORE INTO projects (id, name, cwd, org) VALUES (?, ?, ?, ?)')
      .run(id, name, cwd, org ?? null)
    if (org !== undefined) {
      this.db.prepare('UPDATE projects SET org = ? WHERE id = ?').run(org, id)
    }
  }

  get(id: string): ProjectRow | null {
    const row = this.db
      .prepare('SELECT id, name, cwd, org FROM projects WHERE id = ?')
      .get(id) as ProjectRow | undefined
    return row ?? null
  }

  list(org?: string): ProjectRow[] {
    if (org !== undefined) {
      return this.db
        .prepare('SELECT id, name, cwd, org FROM projects WHERE org = ? ORDER BY name')
        .all(org) as ProjectRow[]
    }
    return this.db
      .prepare('SELECT id, name, cwd, org FROM projects ORDER BY name')
      .all() as ProjectRow[]
  }

  // Removes an unused project and its workspaces in one transaction. Refuses, and
  // deletes nothing, while any PROJECT_OWNED_TABLES row still names the project.
  remove(id: string): RemoveProjectResult {
    return this.db.transaction((): RemoveProjectResult => {
      if (!this.get(id)) return { removed: false, reason: 'not-found' }
      const blockers: Record<string, number> = {}
      for (const table of PROJECT_OWNED_TABLES) {
        const { n } = this.db
          .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`)
          .get(id) as { n: number }
        if (n > 0) blockers[table] = n
      }
      if (Object.keys(blockers).length > 0) return { removed: false, reason: 'in-use', blockers }
      const ws = this.db.prepare('DELETE FROM workspaces WHERE project_id = ?').run(id)
      this.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
      return { removed: true, workspacesRemoved: ws.changes }
    })()
  }
}
