// ADR-030 — Postgres sibling of ContextSourceRepository.
// `is_active` is BOOLEAN (SQLite stored INTEGER 0/1) so the repo boundary
// passes/receives a native boolean — no manual coercion needed.

import type { Queryable, SqlValue } from './connection'
import type {
  ContextCategory,
  ContextSource,
  ContextSourceType,
  CreateContextSourceInput,
  UpdateContextSourceInput
} from '../../task-types'
import { generateId } from '../shared'

interface ContextSourceDbRow {
  id: string
  project_id: string
  source_type: string
  source_path: string
  label: string
  category: string
  priority: number
  is_active: boolean
}

function mapRow(row: ContextSourceDbRow): ContextSource {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceType: row.source_type as ContextSourceType,
    sourcePath: row.source_path,
    label: row.label,
    category: row.category as ContextCategory,
    priority: row.priority,
    isActive: row.is_active
  }
}

const SELECT_COLS =
  'id, project_id, source_type, source_path, label, category, priority, is_active'

export class PostgresContextSourceRepository {
  constructor(private readonly conn: Queryable) {}

  async create(input: CreateContextSourceInput): Promise<ContextSource> {
    const id = input.id || generateId('CTXSRC')
    await this.conn.query(
      `INSERT INTO context_sources
         (id, project_id, source_type, source_path, label, category, priority, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        input.projectId,
        input.sourceType,
        input.sourcePath,
        input.label,
        input.category,
        input.priority ?? 100,
        input.isActive === false ? false : true
      ]
    )
    const got = await this.get(id)
    if (!got) throw new Error(`ContextSource disappeared after insert: ${id}`)
    return got
  }

  async update(id: string, input: UpdateContextSourceInput): Promise<ContextSource> {
    const sets: string[] = []
    const params: SqlValue[] = []
    let n = 1

    if (input.sourceType !== undefined) {
      sets.push(`source_type = $${n++}`)
      params.push(input.sourceType)
    }
    if (input.sourcePath !== undefined) {
      sets.push(`source_path = $${n++}`)
      params.push(input.sourcePath)
    }
    if (input.label !== undefined) {
      sets.push(`label = $${n++}`)
      params.push(input.label)
    }
    if (input.category !== undefined) {
      sets.push(`category = $${n++}`)
      params.push(input.category)
    }
    if (input.priority !== undefined) {
      sets.push(`priority = $${n++}`)
      params.push(input.priority)
    }
    if (input.isActive !== undefined) {
      sets.push(`is_active = $${n++}`)
      params.push(input.isActive)
    }

    if (sets.length === 0) {
      const s = await this.get(id)
      if (!s) throw new Error(`ContextSource not found: ${id}`)
      return s
    }

    params.push(id)
    await this.conn.query(
      `UPDATE context_sources SET ${sets.join(', ')} WHERE id = $${n}`,
      params
    )
    const s = await this.get(id)
    if (!s) throw new Error(`ContextSource not found: ${id}`)
    return s
  }

  async get(id: string): Promise<ContextSource | null> {
    const result = await this.conn.query<ContextSourceDbRow>(
      `SELECT ${SELECT_COLS} FROM context_sources WHERE id = $1`,
      [id]
    )
    const row = result.rows[0]
    return row ? mapRow(row) : null
  }

  async findByProject(projectId: string, activeOnly = false): Promise<ContextSource[]> {
    const result = activeOnly
      ? await this.conn.query<ContextSourceDbRow>(
          `SELECT ${SELECT_COLS} FROM context_sources
           WHERE project_id = $1 AND is_active = TRUE
           ORDER BY priority, label`,
          [projectId]
        )
      : await this.conn.query<ContextSourceDbRow>(
          `SELECT ${SELECT_COLS} FROM context_sources
           WHERE project_id = $1
           ORDER BY priority, label`,
          [projectId]
        )
    return result.rows.map(mapRow)
  }

  async delete(id: string): Promise<void> {
    await this.conn.query('DELETE FROM context_sources WHERE id = $1', [id])
  }
}
