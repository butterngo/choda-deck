import type Database from 'better-sqlite3'
import type {
  ToolInvocation,
  ToolInvocationOperations
} from '../interfaces/tool-invocations-repository.interface'

export class ToolInvocationsRepository implements ToolInvocationOperations {
  private readonly insertStmt: Database.Statement
  private readonly countStmt: Database.Statement

  constructor(db: Database.Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO tool_invocations (tool_name, ts, duration_ms, ok, error_kind)
       VALUES (?, ?, ?, ?, ?)`
    )
    this.countStmt = db.prepare('SELECT COUNT(*) AS n FROM tool_invocations')
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
}
