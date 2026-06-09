import type Database from 'better-sqlite3'
import type {
  AddEvidenceInput,
  Evidence,
  EvidenceType,
  Hypothesis,
  HypothesisStatus,
  Investigation,
  InvestigationStatus,
  StartInvestigationInput
} from '../investigation-types'
import { now } from './shared'
import type { CounterRepository } from './counter-repository'

function rowToInvestigation(row: Record<string, unknown>): Investigation {
  return {
    id: row.id as string,
    symptom: row.symptom as string,
    status: row.status as InvestigationStatus,
    taskId: (row.task_id as string) || null,
    sessionId: (row.session_id as string) || null,
    rootCause: (row.root_cause as string) || null,
    fixSummary: (row.fix_summary as string) || null,
    patternTag: (row.pattern_tag as string) || null,
    createdAt: row.created_at as string,
    resolvedAt: (row.resolved_at as string) || null,
    hypotheses: [],
    evidence: []
  }
}

function rowToHypothesis(row: Record<string, unknown>): Hypothesis {
  return {
    id: row.id as string,
    investigationId: row.investigation_id as string,
    description: row.description as string,
    status: row.status as HypothesisStatus,
    createdAt: row.created_at as string
  }
}

function rowToEvidence(row: Record<string, unknown>): Evidence {
  return {
    id: row.id as string,
    investigationId: row.investigation_id as string,
    hypothesisId: (row.hypothesis_id as string) || null,
    type: row.type as EvidenceType,
    ref: row.ref as string,
    note: (row.note as string) || null,
    createdAt: row.created_at as string
  }
}

// Pure SQL over the three investigation tables. Validation + transactions live in
// InvestigationLifecycleService (ADR-035 / ADR-015) — this repo only reads/writes.
export class InvestigationRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly counters: CounterRepository
  ) {}

  private nextId(prefix: string, entity: string): string {
    return `${prefix}-${String(this.counters.nextNumber(entity)).padStart(3, '0')}`
  }

  insertInvestigation(input: StartInvestigationInput): Investigation {
    const ts = now()
    const id = this.nextId('INV', 'investigation')
    this.db
      .prepare(
        `INSERT INTO investigations (id, symptom, status, task_id, session_id, created_at)
         VALUES (?, ?, 'exploring', ?, ?, ?)`
      )
      .run(id, input.symptom, input.taskId ?? null, input.sessionId ?? null, ts)
    return this.getInvestigation(id)!
  }

  // Nested read: investigation row + all hypotheses + all evidence (AC-5).
  getInvestigation(id: string): Investigation | null {
    const row = this.db.prepare('SELECT * FROM investigations WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    if (!row) return null
    const investigation = rowToInvestigation(row)
    investigation.hypotheses = (
      this.db
        .prepare('SELECT * FROM hypotheses WHERE investigation_id = ? ORDER BY created_at, rowid')
        .all(id) as Array<Record<string, unknown>>
    ).map(rowToHypothesis)
    investigation.evidence = (
      this.db
        .prepare('SELECT * FROM evidence WHERE investigation_id = ? ORDER BY created_at, rowid')
        .all(id) as Array<Record<string, unknown>>
    ).map(rowToEvidence)
    return investigation
  }

  setInvestigationResolved(
    id: string,
    fields: { rootCause: string; fixSummary: string; patternTag: string | null }
  ): void {
    this.db
      .prepare(
        `UPDATE investigations
         SET status = 'resolved', root_cause = ?, fix_summary = ?, pattern_tag = ?, resolved_at = ?
         WHERE id = ?`
      )
      .run(fields.rootCause, fields.fixSummary, fields.patternTag, now(), id)
  }

  insertHypothesis(investigationId: string, description: string): Hypothesis {
    const id = this.nextId('HYP', 'hypothesis')
    this.db
      .prepare(
        `INSERT INTO hypotheses (id, investigation_id, description, status, created_at)
         VALUES (?, ?, ?, 'testing', ?)`
      )
      .run(id, investigationId, description, now())
    return this.getHypothesis(id)!
  }

  getHypothesis(id: string): Hypothesis | null {
    const row = this.db.prepare('SELECT * FROM hypotheses WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? rowToHypothesis(row) : null
  }

  setHypothesisStatus(id: string, status: HypothesisStatus): void {
    this.db.prepare('UPDATE hypotheses SET status = ? WHERE id = ?').run(status, id)
  }

  insertEvidence(input: AddEvidenceInput): Evidence {
    const id = this.nextId('EVID', 'evidence')
    this.db
      .prepare(
        `INSERT INTO evidence (id, investigation_id, hypothesis_id, type, ref, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.investigationId,
        input.hypothesisId ?? null,
        input.type,
        input.ref,
        input.note ?? null,
        now()
      )
    return this.getEvidence(id)!
  }

  getEvidence(id: string): Evidence | null {
    const row = this.db.prepare('SELECT * FROM evidence WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? rowToEvidence(row) : null
  }
}
