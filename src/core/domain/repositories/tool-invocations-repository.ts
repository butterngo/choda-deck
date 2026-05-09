import type Database from 'better-sqlite3'
import type {
  ToolInvocation,
  ToolInvocationAggregate,
  ToolInvocationOperations,
  ToolInvocationWindow
} from '../interfaces/tool-invocations-repository.interface'

interface AggregateRow {
  tool: string
  calls: number
  errors: number
  avgDurationMs: number
  lastUsedAt: string
}

export class ToolInvocationsRepository implements ToolInvocationOperations {
  private readonly insertStmt: Database.Statement
  private readonly countStmt: Database.Statement
  private readonly queryStmt: Database.Statement

  constructor(db: Database.Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO tool_invocations (tool_name, ts, duration_ms, ok, error_kind)
       VALUES (?, ?, ?, ?, ?)`
    )
    this.countStmt = db.prepare('SELECT COUNT(*) AS n FROM tool_invocations')
    // SQLite has no native bool — we stored ok as 0/1, so SUM(1-ok) gives errors.
    this.queryStmt = db.prepare(
      `SELECT
         tool_name AS tool,
         COUNT(*) AS calls,
         SUM(1 - ok) AS errors,
         AVG(duration_ms) AS avgDurationMs,
         MAX(ts) AS lastUsedAt
       FROM tool_invocations
       WHERE (@since IS NULL OR ts >= @since)
         AND (@until IS NULL OR ts <= @until)
       GROUP BY tool_name`
    )
  }

  recordToolInvocation(invocation: ToolInvocation): void {
    this.insertStmt.run(
      invocation.toolName,
      invocation.ts,
      invocation.durationMs,
      invocation.ok ? 1 : 0,
      invocation.errorKind
    )
  }

  countToolInvocations(): number {
    const row = this.countStmt.get() as { n: number }
    return row.n
  }

  queryToolInvocations(window: ToolInvocationWindow): ToolInvocationAggregate[] {
    const rows = this.queryStmt.all({
      since: window.since,
      until: window.until
    }) as AggregateRow[]
    return rows
  }
}
