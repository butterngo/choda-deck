// ADR-030 — Postgres sibling of ProjectRepository. Same contract; ON CONFLICT
// DO NOTHING replaces SQLite's INSERT OR IGNORE for the upsert-skip idiom.

import type { Queryable } from './connection'
import type { ProjectRow } from '../project-repository'

export class PostgresProjectRepository {
  constructor(private readonly conn: Queryable) {}

  async ensure(id: string, name: string, cwd: string): Promise<void> {
    await this.conn.query(
      'INSERT INTO projects (id, name, cwd) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
      [id, name, cwd]
    )
  }

  async get(id: string): Promise<ProjectRow | null> {
    const result = await this.conn.query<ProjectRow>(
      'SELECT id, name, cwd FROM projects WHERE id = $1',
      [id]
    )
    return result.rows[0] ?? null
  }

  async list(): Promise<ProjectRow[]> {
    const result = await this.conn.query<ProjectRow>(
      'SELECT id, name, cwd FROM projects ORDER BY name'
    )
    return result.rows
  }
}
