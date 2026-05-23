// ADR-030 — Postgres sibling of DocumentRepository.
//
// created_at / updated_at are TIMESTAMPTZ in Postgres; rehydrated to ISO-8601
// strings at the repo boundary so the Document shape matches the SQLite repo.

import type { PgConnection } from './connection'
import type {
  CreateDocumentInput,
  Document,
  DocumentType,
  UpdateDocumentInput
} from '../../task-types'
import { generateId } from '../shared'

interface DocumentDbRow {
  id: string
  project_id: string
  type: string
  title: string
  file_path: string | null
  created_at: Date
  updated_at: Date
}

function mapRow(row: DocumentDbRow): Document {
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.type as DocumentType,
    title: row.title,
    filePath: row.file_path,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  }
}

const SELECT_COLS = 'id, project_id, type, title, file_path, created_at, updated_at'

export class PostgresDocumentRepository {
  constructor(private readonly conn: PgConnection) {}

  async create(input: CreateDocumentInput): Promise<Document> {
    const id = input.id || generateId('DOC')
    const now = new Date()
    const result = await this.conn.query<DocumentDbRow>(
      `INSERT INTO documents (id, project_id, type, title, file_path, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       RETURNING ${SELECT_COLS}`,
      [id, input.projectId, input.type, input.title, input.filePath || null, now]
    )
    return mapRow(result.rows[0])
  }

  async update(id: string, input: UpdateDocumentInput): Promise<Document> {
    const sets: string[] = ['updated_at = $1']
    const params: (string | Date | null)[] = [new Date()]
    let n = 2

    if (input.title !== undefined) {
      sets.push(`title = $${n++}`)
      params.push(input.title)
    }
    if (input.type !== undefined) {
      sets.push(`type = $${n++}`)
      params.push(input.type)
    }
    if (input.filePath !== undefined) {
      sets.push(`file_path = $${n++}`)
      params.push(input.filePath)
    }
    params.push(id)

    const result = await this.conn.query<DocumentDbRow>(
      `UPDATE documents SET ${sets.join(', ')} WHERE id = $${n} RETURNING ${SELECT_COLS}`,
      params
    )
    const row = result.rows[0]
    if (!row) throw new Error(`Document not found: ${id}`)
    return mapRow(row)
  }

  async delete(id: string): Promise<void> {
    await this.conn.transaction(async (tx) => {
      await tx.query('DELETE FROM tags WHERE item_id = $1', [id])
      await tx.query('DELETE FROM documents WHERE id = $1', [id])
    })
  }

  async get(id: string): Promise<Document | null> {
    const result = await this.conn.query<DocumentDbRow>(
      `SELECT ${SELECT_COLS} FROM documents WHERE id = $1`,
      [id]
    )
    const row = result.rows[0]
    return row ? mapRow(row) : null
  }

  async findByProject(projectId: string, type?: DocumentType): Promise<Document[]> {
    const result = type
      ? await this.conn.query<DocumentDbRow>(
          `SELECT ${SELECT_COLS} FROM documents WHERE project_id = $1 AND type = $2
           ORDER BY created_at ASC, id ASC`,
          [projectId, type]
        )
      : await this.conn.query<DocumentDbRow>(
          `SELECT ${SELECT_COLS} FROM documents WHERE project_id = $1
           ORDER BY type ASC, created_at ASC`,
          [projectId]
        )
    return result.rows.map(mapRow)
  }
}
