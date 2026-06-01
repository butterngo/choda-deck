import type Database from 'better-sqlite3'
import type {
  CodeRefPrefixFilter,
  CodeRefRow,
  TouchesEdge,
  TouchesRelation,
  UpsertCodeRefInput
} from '../code-ref-types'

function rowToCodeRef(row: Record<string, unknown>): CodeRefRow {
  return {
    slug: row.slug as string,
    projectId: row.project_id as string,
    workspaceId: (row.workspace_id as string | null) ?? null,
    path: row.path as string,
    symbol: (row.symbol as string | null) ?? null,
    lineHint: (row.line_hint as number | null) ?? null,
    commitSha: (row.commit_sha as string | null) ?? null,
    createdAt: row.created_at as string,
    lastVerifiedAt: row.last_verified_at as string
  }
}

export class CodeRefRepository {
  constructor(private readonly db: Database.Database) {}

  // Identity = (project_id, path, COALESCE(symbol,'')). A write matching an
  // existing identity re-pins commit_sha / line_hint / last_verified_at on the
  // ORIGINAL slug instead of inserting a second row (ADR Pillar 2c). The slug
  // supplied on such a write is ignored in favour of the existing one.
  upsert(input: UpsertCodeRefInput, nowIso: string): CodeRefRow {
    const existing = this.getByIdentity(input.projectId, input.path, input.symbol ?? null)
    if (existing) {
      this.db
        .prepare(
          `UPDATE code_refs
             SET commit_sha = ?, line_hint = ?, workspace_id = ?, last_verified_at = ?
           WHERE slug = ?`
        )
        .run(
          input.commitSha ?? existing.commitSha,
          input.lineHint ?? existing.lineHint,
          input.workspaceId ?? existing.workspaceId,
          nowIso,
          existing.slug
        )
      return this.get(existing.slug) as CodeRefRow
    }
    this.db
      .prepare(
        `INSERT INTO code_refs
           (slug, project_id, workspace_id, path, symbol, line_hint, commit_sha, created_at, last_verified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.slug,
        input.projectId,
        input.workspaceId ?? null,
        input.path,
        input.symbol ?? null,
        input.lineHint ?? null,
        input.commitSha ?? null,
        nowIso,
        nowIso
      )
    return this.get(input.slug) as CodeRefRow
  }

  get(slug: string): CodeRefRow | null {
    const row = this.db.prepare('SELECT * FROM code_refs WHERE slug = ?').get(slug) as
      | Record<string, unknown>
      | undefined
    return row ? rowToCodeRef(row) : null
  }

  getByIdentity(projectId: string, path: string, symbol: string | null): CodeRefRow | null {
    const row = this.db
      .prepare(
        "SELECT * FROM code_refs WHERE project_id = ? AND path = ? AND COALESCE(symbol, '') = COALESCE(?, '')"
      )
      .get(projectId, path, symbol) as Record<string, unknown> | undefined
    return row ? rowToCodeRef(row) : null
  }

  // Prefix query over the dotted symbol (ADR Pillar 2c): e.g. all Domain-layer
  // refs via symbolPrefix = 'Ichiba.Pim.TradingCatalog.Domain.'. Falls back to
  // a path filter, or lists the whole project when neither is given.
  listByPrefix(filter: CodeRefPrefixFilter): CodeRefRow[] {
    const where: string[] = ['project_id = ?']
    const params: (string | number)[] = [filter.projectId]
    if (filter.symbolPrefix) {
      where.push('symbol LIKE ? ESCAPE ?')
      params.push(`${escapeLike(filter.symbolPrefix)}%`, '\\')
    }
    if (filter.path) {
      where.push('path = ?')
      params.push(filter.path)
    }
    const rows = this.db
      .prepare(`SELECT * FROM code_refs WHERE ${where.join(' AND ')} ORDER BY symbol, path`)
      .all(...params) as Record<string, unknown>[]
    return rows.map(rowToCodeRef)
  }

  delete(slug: string): void {
    this.db.prepare('DELETE FROM task_code_refs WHERE code_ref_slug = ?').run(slug)
    this.db.prepare('DELETE FROM code_refs WHERE slug = ?').run(slug)
  }

  // ── TOUCHES edges ──────────────────────────────────────────────────────────

  addTouches(taskId: string, codeRefSlug: string, relation: TouchesRelation): void {
    this.db
      .prepare(
        `INSERT INTO task_code_refs (task_id, code_ref_slug, relation)
         VALUES (?, ?, ?)
         ON CONFLICT(task_id, code_ref_slug) DO UPDATE SET relation = excluded.relation`
      )
      .run(taskId, codeRefSlug, relation)
  }

  removeTouches(taskId: string, codeRefSlug: string): void {
    this.db
      .prepare('DELETE FROM task_code_refs WHERE task_id = ? AND code_ref_slug = ?')
      .run(taskId, codeRefSlug)
  }

  getTouchesForTask(taskId: string): TouchesEdge[] {
    const rows = this.db
      .prepare('SELECT * FROM task_code_refs WHERE task_id = ? ORDER BY code_ref_slug')
      .all(taskId) as Array<{ task_id: string; code_ref_slug: string; relation: string }>
    return rows.map((r) => ({
      taskId: r.task_id,
      codeRefSlug: r.code_ref_slug,
      relation: r.relation as TouchesRelation
    }))
  }

  getTouchesForCodeRef(codeRefSlug: string): TouchesEdge[] {
    const rows = this.db
      .prepare('SELECT * FROM task_code_refs WHERE code_ref_slug = ? ORDER BY task_id')
      .all(codeRefSlug) as Array<{ task_id: string; code_ref_slug: string; relation: string }>
    return rows.map((r) => ({
      taskId: r.task_id,
      codeRefSlug: r.code_ref_slug,
      relation: r.relation as TouchesRelation
    }))
  }
}

// Escapes LIKE wildcards in user-supplied prefixes so a literal '%' or '_' in a
// symbol prefix matches itself (paired with `ESCAPE '\'` in the query).
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`)
}
