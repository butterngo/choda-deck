// ADR-030 — Postgres sibling of ProjectRepository. Same contract; ON CONFLICT
// DO NOTHING replaces SQLite's INSERT OR IGNORE for the upsert-skip idiom.

import type { Queryable } from './connection'
import type { ProjectRow } from '../project-repository'

export class PostgresProjectRepository {
  constructor(private readonly conn: Queryable) {}

  async ensure(id: string, name: string, cwd: string, org?: string | null): Promise<void> {
    await this.conn.query(
      'INSERT INTO projects (id, name, cwd, org) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING',
      [id, name, cwd, org ?? null]
    )
    if (org !== undefined) {
      await this.conn.query('UPDATE projects SET org = $1 WHERE id = $2', [org, id])
    }
  }

  async get(id: string): Promise<ProjectRow | null> {
    const result = await this.conn.query<ProjectRow>(
      'SELECT id, name, cwd, org FROM projects WHERE id = $1',
      [id]
    )
    return result.rows[0] ?? null
  }

  async list(org?: string): Promise<ProjectRow[]> {
    const result =
      org !== undefined
        ? await this.conn.query<ProjectRow>(
            'SELECT id, name, cwd, org FROM projects WHERE org = $1 ORDER BY name',
            [org]
          )
        : await this.conn.query<ProjectRow>('SELECT id, name, cwd, org FROM projects ORDER BY name')
    return result.rows
  }
}
