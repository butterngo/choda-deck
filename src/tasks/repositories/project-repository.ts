import type Database from 'better-sqlite3'

export class ProjectRepository {
  constructor(private readonly db: Database.Database) {}

  ensure(id: string, name: string, cwd: string): void {
    this.db.prepare('INSERT OR IGNORE INTO projects (id, name, cwd) VALUES (?, ?, ?)').run(id, name, cwd)
  }
}
