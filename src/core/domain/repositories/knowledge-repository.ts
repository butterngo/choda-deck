import type Database from 'better-sqlite3'
import type {
  KnowledgeIndexRow,
  KnowledgeListFilter,
  KnowledgeScope,
  KnowledgeType
} from '../knowledge-types'

function rowToIndex(row: Record<string, unknown>): KnowledgeIndexRow {
  return {
    slug: row.slug as string,
    projectId: row.project_id as string,
    workspaceId: (row.workspace_id as string | null) ?? null,
    scope: row.scope as KnowledgeScope,
    type: row.type as KnowledgeType,
    title: row.title as string,
    filePath: row.file_path as string,
    createdAt: row.created_at as string,
    lastVerifiedAt: row.last_verified_at as string
  }
}

export class KnowledgeRepository {
  constructor(private readonly db: Database.Database) {}

  upsert(row: KnowledgeIndexRow): void {
    this.db
      .prepare(
        `INSERT INTO knowledge_index (slug, project_id, workspace_id, scope, type, title, file_path, created_at, last_verified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET
           project_id = excluded.project_id,
           workspace_id = excluded.workspace_id,
           scope = excluded.scope,
           type = excluded.type,
           title = excluded.title,
           file_path = excluded.file_path,
           last_verified_at = excluded.last_verified_at`
      )
      .run(
        row.slug,
        row.projectId,
        row.workspaceId,
        row.scope,
        row.type,
        row.title,
        row.filePath,
        row.createdAt,
        row.lastVerifiedAt
      )
  }

  get(slug: string): KnowledgeIndexRow | null {
    const row = this.db.prepare('SELECT * FROM knowledge_index WHERE slug = ?').get(slug) as
      | Record<string, unknown>
      | undefined
    return row ? rowToIndex(row) : null
  }

  list(filter: KnowledgeListFilter = {}): KnowledgeIndexRow[] {
    const where: string[] = []
    const params: (string | number)[] = []
    if (filter.projectId) {
      where.push('project_id = ?')
      params.push(filter.projectId)
    }
    if (filter.workspaceId === null) {
      where.push('workspace_id IS NULL')
    } else if (filter.workspaceId !== undefined) {
      where.push('workspace_id = ?')
      params.push(filter.workspaceId)
    }
    if (filter.scope) {
      where.push('scope = ?')
      params.push(filter.scope)
    }
    if (filter.type) {
      where.push('type = ?')
      params.push(filter.type)
    }
    const sql = `SELECT * FROM knowledge_index ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[]
    return rows.map(rowToIndex)
  }

  listByProject(projectId: string): KnowledgeIndexRow[] {
    return this.list({ projectId })
  }

  updateLastVerified(slug: string, lastVerifiedAt: string): void {
    this.db
      .prepare('UPDATE knowledge_index SET last_verified_at = ? WHERE slug = ?')
      .run(lastVerifiedAt, slug)
  }

  delete(slug: string): void {
    this.db.prepare('DELETE FROM knowledge_index WHERE slug = ?').run(slug)
  }
}
