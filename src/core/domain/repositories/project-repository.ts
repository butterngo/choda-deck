import type Database from 'better-sqlite3'

// TASK-3128 — rule 4 of personal-operating-rules: what a project gives Butter.
export const PROJECT_PURPOSES = ['income', 'reputation', 'fun'] as const
export type ProjectPurpose = (typeof PROJECT_PURPOSES)[number]

export function isProjectPurpose(v: unknown): v is ProjectPurpose {
  return typeof v === 'string' && (PROJECT_PURPOSES as readonly string[]).includes(v)
}

export interface ProjectRow {
  id: string
  name: string
  cwd: string
  // TASK-2200 — the organisation a project belongs to (ichiba, mantu, personal…).
  // Nullable: projects created before the column, or never assigned, have none.
  org: string | null
  // TASK-3128 — null on projects created before the column until Butter fills it.
  purpose: ProjectPurpose | null
}

export interface ProjectPatch {
  name?: string
  cwd?: string
  purpose?: ProjectPurpose
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
  // `purpose` (TASK-3128) follows the same rule: an omitted one leaves the stored value.
  ensure(
    id: string,
    name: string,
    cwd: string,
    org?: string | null,
    purpose?: ProjectPurpose
  ): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO projects (id, name, cwd, org, purpose) VALUES (?, ?, ?, ?, ?)'
      )
      .run(id, name, cwd, org ?? null, purpose ?? null)
    if (org !== undefined) {
      this.db.prepare('UPDATE projects SET org = ? WHERE id = ?').run(org, id)
    }
    if (purpose !== undefined) {
      this.db.prepare('UPDATE projects SET purpose = ? WHERE id = ?').run(purpose, id)
    }
  }

  // Rewrites name and/or cwd in place — ensure() deliberately never touches them on
  // an existing project, so a moved repo needs this explicit path.
  update(id: string, patch: ProjectPatch): ProjectRow | null {
    const existing = this.get(id)
    if (!existing) return null
    const name = patch.name ?? existing.name
    const cwd = patch.cwd ?? existing.cwd
    const purpose = patch.purpose ?? existing.purpose
    this.db
      .prepare('UPDATE projects SET name = ?, cwd = ?, purpose = ? WHERE id = ?')
      .run(name, cwd, purpose, id)
    return { ...existing, name, cwd, purpose }
  }

  get(id: string): ProjectRow | null {
    const row = this.db
      .prepare('SELECT id, name, cwd, org, purpose FROM projects WHERE id = ?')
      .get(id) as ProjectRow | undefined
    return row ?? null
  }

  list(org?: string): ProjectRow[] {
    if (org !== undefined) {
      return this.db
        .prepare('SELECT id, name, cwd, org, purpose FROM projects WHERE org = ? ORDER BY name')
        .all(org) as ProjectRow[]
    }
    return this.db
      .prepare('SELECT id, name, cwd, org, purpose FROM projects ORDER BY name')
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
