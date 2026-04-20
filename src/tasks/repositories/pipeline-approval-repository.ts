import type Database from 'better-sqlite3'

export interface PipelineApprovalRow {
  id: number
  sessionId: string
  stage: string
  iteration: number
  decision: 'approve' | 'reject' | 'abort'
  feedback: string | null
  createdAt: string
}

export interface LogPipelineApprovalInput {
  sessionId: string
  stage: string
  iteration: number
  decision: 'approve' | 'reject' | 'abort'
  feedback?: string
}

function rowToApproval(row: Record<string, unknown>): PipelineApprovalRow {
  return {
    id: row.id as number,
    sessionId: row.session_id as string,
    stage: row.stage as string,
    iteration: row.iteration as number,
    decision: row.decision as 'approve' | 'reject' | 'abort',
    feedback: (row.feedback as string) || null,
    createdAt: row.created_at as string
  }
}

export class PipelineApprovalRepository {
  constructor(private readonly db: Database.Database) {}

  log(input: LogPipelineApprovalInput): PipelineApprovalRow {
    const result = this.db
      .prepare(
        `INSERT INTO pipeline_approvals (session_id, stage, iteration, decision, feedback)
         VALUES (?, ?, ?, ?, ?) RETURNING *`
      )
      .get(
        input.sessionId,
        input.stage,
        input.iteration,
        input.decision,
        input.feedback ?? null
      ) as Record<string, unknown>
    return rowToApproval(result)
  }

  findBySession(sessionId: string): PipelineApprovalRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM pipeline_approvals WHERE session_id = ? ORDER BY id ASC`
      )
      .all(sessionId) as Array<Record<string, unknown>>
    return rows.map(rowToApproval)
  }
}
