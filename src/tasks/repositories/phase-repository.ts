import type Database from 'better-sqlite3'
import type { Phase, PhaseStatus, CreatePhaseInput, UpdatePhaseInput, DerivedProgress } from '../task-types'
import { now, type Param } from './shared'

function rowToPhase(row: Record<string, unknown>): Phase {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    title: row.title as string,
    status: row.status as PhaseStatus,
    position: (row.position as number) || 0,
    startDate: (row.start_date as string) || null,
    completedDate: (row.completed_date as string) || null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  }
}

export class PhaseRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: CreatePhaseInput): Phase {
    const ts = now()
    const id = input.id || `PHASE-${Date.now()}`
    this.db.prepare(
      'INSERT INTO phases (id, project_id, title, status, position, start_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, input.projectId, input.title, input.status || 'open', input.position || 0, input.startDate || null, ts, ts)
    return this.get(id)!
  }

  update(id: string, input: UpdatePhaseInput): Phase {
    const sets: string[] = ['updated_at = ?']
    const params: Param[] = [now()]

    if (input.title !== undefined) { sets.push('title = ?'); params.push(input.title) }
    if (input.status !== undefined) { sets.push('status = ?'); params.push(input.status) }
    if (input.position !== undefined) { sets.push('position = ?'); params.push(input.position) }
    if (input.startDate !== undefined) { sets.push('start_date = ?'); params.push(input.startDate) }
    if (input.completedDate !== undefined) { sets.push('completed_date = ?'); params.push(input.completedDate) }

    params.push(id)
    this.db.prepare(`UPDATE phases SET ${sets.join(', ')} WHERE id = ?`).run(...params as (string | number | null)[])
    const phase = this.get(id)
    if (!phase) throw new Error(`Phase not found: ${id}`)
    return phase
  }

  delete(id: string): void {
    this.db.prepare('UPDATE features SET phase_id = NULL WHERE phase_id = ?').run(id)
    this.db.prepare('DELETE FROM phases WHERE id = ?').run(id)
  }

  get(id: string): Phase | null {
    const row = this.db.prepare('SELECT * FROM phases WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? rowToPhase(row) : null
  }

  findByProject(projectId: string): Phase[] {
    const rows = this.db.prepare('SELECT * FROM phases WHERE project_id = ? ORDER BY position').all(projectId) as Array<Record<string, unknown>>
    return rows.map(rowToPhase)
  }

  getProgress(phaseId: string): DerivedProgress {
    const phase = this.get(phaseId)
    const row = this.db.prepare(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN t.status = 'DONE' THEN 1 ELSE 0 END) as done,
              SUM(CASE WHEN t.status = 'IN-PROGRESS' THEN 1 ELSE 0 END) as ip
       FROM tasks t
       JOIN features f ON t.feature_id = f.id
       WHERE f.phase_id = ?`
    ).get(phaseId) as Record<string, number> | undefined
    const total = row?.total || 0
    const done = row?.done || 0
    const inProgress = row?.ip || 0
    const percent = total === 0 ? 0 : Math.round((done / total) * 100)
    const status = this.deriveProgressStatus(phase, total, done)
    return { total, done, inProgress, status, percent }
  }

  private deriveProgressStatus(phase: Phase | null, total: number, done: number): 'planned' | 'active' | 'completed' {
    if (total > 0 && done === total) {
      if (phase && !phase.completedDate) {
        this.update(phase.id, { completedDate: now().split('T')[0] })
      }
      return 'completed'
    }
    if (phase?.startDate) {
      if (phase.completedDate) {
        this.update(phase.id, { completedDate: null })
      }
      return 'active'
    }
    return 'planned'
  }
}
