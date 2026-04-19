import type Database from 'better-sqlite3'
import type {
  ContextSource,
  ContextSourceType,
  ContextCategory,
  CreateContextSourceInput,
  UpdateContextSourceInput
} from '../task-types'
import { generateId, type Param } from './shared'

function rowToContextSource(row: Record<string, unknown>): ContextSource {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    sourceType: row.source_type as ContextSourceType,
    sourcePath: row.source_path as string,
    label: row.label as string,
    category: row.category as ContextCategory,
    priority: row.priority as number,
    isActive: row.is_active === 1
  }
}

export class ContextSourceRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: CreateContextSourceInput): ContextSource {
    const id = input.id || generateId('CTXSRC')
    this.db
      .prepare(
        `INSERT INTO context_sources (id, project_id, source_type, source_path, label, category, priority, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.projectId,
        input.sourceType,
        input.sourcePath,
        input.label,
        input.category,
        input.priority ?? 100,
        input.isActive === false ? 0 : 1
      )
    return this.get(id)!
  }

  update(id: string, input: UpdateContextSourceInput): ContextSource {
    const sets: string[] = []
    const params: Param[] = []

    if (input.sourceType !== undefined) {
      sets.push('source_type = ?')
      params.push(input.sourceType)
    }
    if (input.sourcePath !== undefined) {
      sets.push('source_path = ?')
      params.push(input.sourcePath)
    }
    if (input.label !== undefined) {
      sets.push('label = ?')
      params.push(input.label)
    }
    if (input.category !== undefined) {
      sets.push('category = ?')
      params.push(input.category)
    }
    if (input.priority !== undefined) {
      sets.push('priority = ?')
      params.push(input.priority)
    }
    if (input.isActive !== undefined) {
      sets.push('is_active = ?')
      params.push(input.isActive ? 1 : 0)
    }

    if (sets.length === 0) {
      const s = this.get(id)
      if (!s) throw new Error(`ContextSource not found: ${id}`)
      return s
    }

    params.push(id)
    this.db
      .prepare(`UPDATE context_sources SET ${sets.join(', ')} WHERE id = ?`)
      .run(...(params as (string | number | null)[]))
    const s = this.get(id)
    if (!s) throw new Error(`ContextSource not found: ${id}`)
    return s
  }

  get(id: string): ContextSource | null {
    const row = this.db.prepare('SELECT * FROM context_sources WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? rowToContextSource(row) : null
  }

  findByProject(projectId: string, activeOnly = false): ContextSource[] {
    const sql = activeOnly
      ? 'SELECT * FROM context_sources WHERE project_id = ? AND is_active = 1 ORDER BY priority, label'
      : 'SELECT * FROM context_sources WHERE project_id = ? ORDER BY priority, label'
    const rows = this.db.prepare(sql).all(projectId) as Array<Record<string, unknown>>
    return rows.map(rowToContextSource)
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM context_sources WHERE id = ?').run(id)
  }
}
