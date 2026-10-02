// TASK-2253 — SQLite sibling of PostgresProjectMemberRepository (TASK-2243).
// The live remote runs the SQLite backend, so membership has to exist here
// too. Same contract and result values; async so both implementations fit the
// member CLI and the HTTP scoping wrapper unchanged.

import type Database from 'better-sqlite3'
import type {
  AddMemberResult,
  RemoveMemberResult
} from './postgres/project-member-repository.pg'

export class ProjectMemberRepository {
  constructor(private readonly db: Database.Database) {}

  async listProjectsFor(member: string): Promise<string[]> {
    const rows = this.db
      .prepare('SELECT project_id FROM project_members WHERE member = ? ORDER BY project_id')
      .all(member) as Array<{ project_id: string }>
    return rows.map((r) => r.project_id)
  }

  async isMember(member: string, projectId: string): Promise<boolean> {
    return (
      this.db
        .prepare('SELECT 1 FROM project_members WHERE member = ? AND project_id = ?')
        .get(member, projectId) !== undefined
    )
  }

  async add(member: string, projectId: string): Promise<AddMemberResult> {
    if (this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId) === undefined) {
      return 'unknown-project'
    }
    const result = this.db
      .prepare('INSERT OR IGNORE INTO project_members (project_id, member) VALUES (?, ?)')
      .run(projectId, member)
    return result.changes > 0 ? 'added' : 'already-member'
  }

  async remove(member: string, projectId: string): Promise<RemoveMemberResult> {
    const result = this.db
      .prepare('DELETE FROM project_members WHERE project_id = ? AND member = ?')
      .run(projectId, member)
    return result.changes > 0 ? 'removed' : 'not-member'
  }
}
