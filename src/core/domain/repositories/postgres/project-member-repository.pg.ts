// TASK-2243 — remote-only membership: which projects a team member (Keycloak
// preferred_username) may see on choda-remote. Postgres only; there is no
// SQLite sibling because the table never reaches the converter's laptop.

import type { Queryable } from './connection'

export type AddMemberResult = 'added' | 'already-member' | 'unknown-project'
export type RemoveMemberResult = 'removed' | 'not-member'

export class PostgresProjectMemberRepository {
  constructor(private readonly conn: Queryable) {}

  async listProjectsFor(member: string): Promise<string[]> {
    const result = await this.conn.query<{ project_id: string }>(
      'SELECT project_id FROM project_members WHERE member = $1 ORDER BY project_id',
      [member]
    )
    return result.rows.map((r) => r.project_id)
  }

  async isMember(member: string, projectId: string): Promise<boolean> {
    const result = await this.conn.query(
      'SELECT 1 FROM project_members WHERE member = $1 AND project_id = $2',
      [member, projectId]
    )
    return result.rows.length > 0
  }

  async add(member: string, projectId: string): Promise<AddMemberResult> {
    const project = await this.conn.query('SELECT 1 FROM projects WHERE id = $1', [projectId])
    if (project.rows.length === 0) return 'unknown-project'
    const inserted = await this.conn.query(
      'INSERT INTO project_members (project_id, member) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [projectId, member]
    )
    return (inserted.rowCount ?? 0) > 0 ? 'added' : 'already-member'
  }

  async remove(member: string, projectId: string): Promise<RemoveMemberResult> {
    const deleted = await this.conn.query(
      'DELETE FROM project_members WHERE project_id = $1 AND member = $2',
      [projectId, member]
    )
    return (deleted.rowCount ?? 0) > 0 ? 'removed' : 'not-member'
  }
}
