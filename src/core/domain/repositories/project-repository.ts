import type Database from 'better-sqlite3'

export interface ProjectRow {
  id: string
  name: string
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
}
