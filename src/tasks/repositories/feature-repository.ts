import type Database from 'better-sqlite3'
import type {
  Feature,
  CreateFeatureInput,
  UpdateFeatureInput,
  DerivedProgress
} from '../task-types'
import { now, generateId, derivedProgress, type Param } from './shared'

function rowToFeature(row: Record<string, unknown>): Feature {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    phaseId: (row.phase_id as string) || null,
    title: row.title as string,
    priority: (row.priority as Feature['priority']) || null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  }
}

export class FeatureRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: CreateFeatureInput): Feature {
    const ts = now()
    const id = input.id || generateId('FEAT')
    this.db
      .prepare(
        'INSERT INTO features (id, project_id, phase_id, title, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(id, input.projectId, input.phaseId || null, input.title, input.priority || null, ts, ts)
    return this.get(id)!
  }

  update(id: string, input: UpdateFeatureInput): Feature {
    const sets: string[] = ['updated_at = ?']
    const params: Param[] = [now()]

    if (input.title !== undefined) {
      sets.push('title = ?')
      params.push(input.title)
    }
    if (input.phaseId !== undefined) {
      sets.push('phase_id = ?')
      params.push(input.phaseId)
    }
    if (input.priority !== undefined) {
      sets.push('priority = ?')
      params.push(input.priority)
    }

    params.push(id)
    this.db
      .prepare(`UPDATE features SET ${sets.join(', ')} WHERE id = ?`)
      .run(...(params as (string | number | null)[]))
    const feature = this.get(id)
    if (!feature) throw new Error(`Feature not found: ${id}`)
    return feature
  }

  delete(id: string): void {
    this.db.prepare('UPDATE tasks SET feature_id = NULL WHERE feature_id = ?').run(id)
    this.db.prepare('DELETE FROM features WHERE id = ?').run(id)
  }

  get(id: string): Feature | null {
    const row = this.db.prepare('SELECT * FROM features WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? rowToFeature(row) : null
  }

  findByProject(projectId: string): Feature[] {
    const rows = this.db
      .prepare('SELECT * FROM features WHERE project_id = ? ORDER BY created_at')
      .all(projectId) as Array<Record<string, unknown>>
    return rows.map(rowToFeature)
  }

  findByPhase(phaseId: string): Feature[] {
    const rows = this.db
      .prepare('SELECT * FROM features WHERE phase_id = ? ORDER BY created_at')
      .all(phaseId) as Array<Record<string, unknown>>
    return rows.map(rowToFeature)
  }

  getProgress(featureId: string): DerivedProgress {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as total,
              SUM(CASE WHEN status = 'DONE' THEN 1 ELSE 0 END) as done,
              SUM(CASE WHEN status = 'IN-PROGRESS' THEN 1 ELSE 0 END) as ip
       FROM tasks WHERE feature_id = ?`
      )
      .get(featureId) as Record<string, number> | undefined
    if (!row) return derivedProgress(0, 0, 0)
    return derivedProgress(row.total || 0, row.done || 0, row.ip || 0)
  }
}
