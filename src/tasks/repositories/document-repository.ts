import type Database from 'better-sqlite3'
import type {
  Document,
  DocumentType,
  CreateDocumentInput,
  UpdateDocumentInput
} from '../task-types'
import { now, generateId, type Param } from './shared'

function rowToDocument(row: Record<string, unknown>): Document {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    type: row.type as DocumentType,
    title: row.title as string,
    filePath: (row.file_path as string) || null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  }
}

export class DocumentRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: CreateDocumentInput): Document {
    const ts = now()
    const id = input.id || generateId('DOC')
    this.db
      .prepare(
        'INSERT INTO documents (id, project_id, type, title, file_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(id, input.projectId, input.type, input.title, input.filePath || null, ts, ts)
    return this.get(id)!
  }

  update(id: string, input: UpdateDocumentInput): Document {
    const sets: string[] = ['updated_at = ?']
    const params: Param[] = [now()]

    if (input.title !== undefined) {
      sets.push('title = ?')
      params.push(input.title)
    }
    if (input.type !== undefined) {
      sets.push('type = ?')
      params.push(input.type)
    }
    if (input.filePath !== undefined) {
      sets.push('file_path = ?')
      params.push(input.filePath)
    }

    params.push(id)
    this.db
      .prepare(`UPDATE documents SET ${sets.join(', ')} WHERE id = ?`)
      .run(...(params as (string | number | null)[]))
    const doc = this.get(id)
    if (!doc) throw new Error(`Document not found: ${id}`)
    return doc
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM tags WHERE item_id = ?').run(id)
    this.db.prepare('DELETE FROM documents WHERE id = ?').run(id)
  }

  get(id: string): Document | null {
    const row = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? rowToDocument(row) : null
  }

  findByProject(projectId: string, type?: DocumentType): Document[] {
    const rows = type
      ? (this.db
          .prepare('SELECT * FROM documents WHERE project_id = ? AND type = ? ORDER BY created_at')
          .all(projectId, type) as Array<Record<string, unknown>>)
      : (this.db
          .prepare('SELECT * FROM documents WHERE project_id = ? ORDER BY type, created_at')
          .all(projectId) as Array<Record<string, unknown>>)
    return rows.map(rowToDocument)
  }
}
