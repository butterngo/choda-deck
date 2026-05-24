// ADR-030 — Postgres sibling of KnowledgeRepository.
// scope + type CHECK constraints inline. workspace_id FK (ADR-022) optional.
// embedding_provider_id / embedding_dims columns exist in the schema for
// forward-compat with the pgvector store slice; this repo doesn't read/write
// them yet, matching the SQLite contract.

import type { Queryable, SqlValue } from './connection'
import type {
  KnowledgeIndexRow,
  KnowledgeListFilter,
  KnowledgeScope,
  KnowledgeType
} from '../../knowledge-types'

interface KnowledgeDbRow {
  slug: string
  project_id: string
  workspace_id: string | null
  scope: string
  type: string
  title: string
  file_path: string
  created_at: string
  last_verified_at: string
}

function mapRow(row: KnowledgeDbRow): KnowledgeIndexRow {
  return {
    slug: row.slug,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    scope: row.scope as KnowledgeScope,
    type: row.type as KnowledgeType,
    title: row.title,
    filePath: row.file_path,
    createdAt: row.created_at,
    lastVerifiedAt: row.last_verified_at
  }
}

const SELECT_COLS =
  'slug, project_id, workspace_id, scope, type, title, file_path, created_at, last_verified_at'

export class PostgresKnowledgeRepository {
  constructor(private readonly conn: Queryable) {}

  async upsert(row: KnowledgeIndexRow): Promise<void> {
    await this.conn.query(
      `INSERT INTO knowledge_index
         (slug, project_id, workspace_id, scope, type, title, file_path, created_at, last_verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (slug) DO UPDATE SET
         project_id = EXCLUDED.project_id,
         workspace_id = EXCLUDED.workspace_id,
         scope = EXCLUDED.scope,
         type = EXCLUDED.type,
         title = EXCLUDED.title,
         file_path = EXCLUDED.file_path,
         last_verified_at = EXCLUDED.last_verified_at`,
      [
        row.slug,
        row.projectId,
        row.workspaceId,
        row.scope,
        row.type,
        row.title,
        row.filePath,
        row.createdAt,
        row.lastVerifiedAt
      ]
    )
  }

  async get(slug: string): Promise<KnowledgeIndexRow | null> {
    const result = await this.conn.query<KnowledgeDbRow>(
      `SELECT ${SELECT_COLS} FROM knowledge_index WHERE slug = $1`,
      [slug]
    )
    const row = result.rows[0]
    return row ? mapRow(row) : null
  }

  async list(filter: KnowledgeListFilter = {}): Promise<KnowledgeIndexRow[]> {
    const wheres: string[] = []
    const params: SqlValue[] = []
    let n = 1

    if (filter.projectId) {
      wheres.push(`project_id = $${n++}`)
      params.push(filter.projectId)
    }
    if (filter.workspaceId === null) {
      wheres.push('workspace_id IS NULL')
    } else if (filter.workspaceId !== undefined) {
      wheres.push(`workspace_id = $${n++}`)
      params.push(filter.workspaceId)
    }
    if (filter.scope) {
      wheres.push(`scope = $${n++}`)
      params.push(filter.scope)
    }
    if (filter.type) {
      wheres.push(`type = $${n++}`)
      params.push(filter.type)
    }
    const where = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : ''
    const result = await this.conn.query<KnowledgeDbRow>(
      `SELECT ${SELECT_COLS} FROM knowledge_index ${where}
       ORDER BY created_at DESC, slug DESC`,
      params
    )
    return result.rows.map(mapRow)
  }

  async listByProject(projectId: string): Promise<KnowledgeIndexRow[]> {
    return this.list({ projectId })
  }

  async updateLastVerified(slug: string, lastVerifiedAt: string): Promise<void> {
    await this.conn.query(
      'UPDATE knowledge_index SET last_verified_at = $1 WHERE slug = $2',
      [lastVerifiedAt, slug]
    )
  }

  async delete(slug: string): Promise<void> {
    await this.conn.query('DELETE FROM knowledge_index WHERE slug = $1', [slug])
  }
}
