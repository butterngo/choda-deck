import type Database from 'better-sqlite3'
import type { InvestigationRepository } from '../repositories/investigation-repository'
import type { SessionRepository } from '../repositories/session-repository'
import type { SessionEventRepository } from '../repositories/session-event-repository'
import type { InvestigationOperations } from '../interfaces/investigation.interface'
import type {
  AddEvidenceInput,
  Evidence,
  Hypothesis,
  HypothesisStatus,
  Investigation,
  KnowledgeDraft,
  ResolveInvestigationInput,
  ResolveInvestigationResult,
  StartInvestigationInput
} from '../investigation-types'
import {
  HypothesisNotFoundError,
  HypothesisTransitionError,
  InvestigationNotFoundError,
  InvestigationStatusError
} from './errors'

// Investigation lifecycle (ADR-035). Single-row writes still flow through here so
// every mutation shares one validation + error model; resolve is the genuinely
// composite op (status flip + returned knowledge draft) wrapped in db.transaction.
export class InvestigationLifecycleService implements InvestigationOperations {
  constructor(
    private readonly db: Database.Database,
    private readonly investigations: InvestigationRepository,
    private readonly sessions: SessionRepository,
    private readonly sessionEvents: SessionEventRepository
  ) {}

  async startInvestigation(input: StartInvestigationInput): Promise<Investigation> {
    return this.investigations.insertInvestigation(input)
  }

  async getInvestigation(id: string): Promise<Investigation | null> {
    return this.investigations.getInvestigation(id)
  }

  async addHypothesis(investigationId: string, description: string): Promise<Hypothesis> {
    const tx = this.db.transaction((): Hypothesis => {
      const inv = this.investigations.getInvestigation(investigationId)
      if (!inv) throw new InvestigationNotFoundError(investigationId)
      if (inv.status === 'resolved') {
        throw new InvestigationStatusError(investigationId, inv.status, 'cannot add a hypothesis')
      }
      return this.investigations.insertHypothesis(investigationId, description)
    })
    return tx()
  }

  // Only testing → ruled_out | confirmed is legal. A terminal hypothesis (already
  // ruled_out/confirmed) cannot transition again, and 'testing' is never a target.
  async setHypothesisStatus(
    hypothesisId: string,
    status: HypothesisStatus
  ): Promise<Hypothesis> {
    const tx = this.db.transaction((): Hypothesis => {
      const hyp = this.investigations.getHypothesis(hypothesisId)
      if (!hyp) throw new HypothesisNotFoundError(hypothesisId)
      const legal = hyp.status === 'testing' && (status === 'ruled_out' || status === 'confirmed')
      if (!legal) throw new HypothesisTransitionError(hypothesisId, hyp.status, status)
      this.investigations.setHypothesisStatus(hypothesisId, status)
      return this.investigations.getHypothesis(hypothesisId)!
    })
    return tx()
  }

  async addEvidence(input: AddEvidenceInput): Promise<Evidence> {
    const tx = this.db.transaction((): Evidence => {
      const inv = this.investigations.getInvestigation(input.investigationId)
      if (!inv) throw new InvestigationNotFoundError(input.investigationId)
      if (input.hypothesisId) {
        const hyp = this.investigations.getHypothesis(input.hypothesisId)
        if (!hyp || hyp.investigationId !== input.investigationId) {
          throw new HypothesisNotFoundError(input.hypothesisId)
        }
      }
      return this.investigations.insertEvidence(input)
    })
    return tx()
  }

  async resolveInvestigation(
    id: string,
    input: ResolveInvestigationInput
  ): Promise<ResolveInvestigationResult> {
    const tx = this.db.transaction((): ResolveInvestigationResult => {
      const inv = this.investigations.getInvestigation(id)
      if (!inv) throw new InvestigationNotFoundError(id)
      if (inv.status === 'resolved') {
        throw new InvestigationStatusError(id, inv.status, 'already resolved')
      }
      const patternTag = input.patternTag ?? null
      this.investigations.setInvestigationResolved(id, {
        rootCause: input.rootCause,
        fixSummary: input.fixSummary,
        patternTag
      })
      const investigation = this.investigations.getInvestigation(id)!
      // Human-gated knowledge draft — returned, NOT written to the knowledge layer
      // inside this transaction (ADR-035 / harvest-knowledge memoryCandidate rail).
      const knowledgeDraft = buildKnowledgeDraft(investigation)
      this.emitGotchaDraft(investigation)
      return { investigation, knowledgeDraft }
    })
    return tx()
  }

  // TASK-2342 — feed the root cause into the TASK-998 gotcha_draft rail so it
  // surfaces in session_end's memoryCandidates. Lands on the investigation's own
  // session while active, else the task's active session; none → no draft.
  private emitGotchaDraft(inv: Investigation): void {
    if (!inv.rootCause?.trim()) return
    const own = inv.sessionId ? this.sessions.get(inv.sessionId) : null
    const session =
      own?.status === 'active'
        ? own
        : inv.taskId
          ? (this.sessions.findActiveByTask(inv.taskId)[0] ?? null)
          : null
    if (!session) return
    this.sessionEvents.create({
      sessionId: session.id,
      eventType: 'observation',
      payloadJson: JSON.stringify({
        kind: 'gotcha_draft',
        trigger: inv.symptom,
        context: inv.symptom,
        businessRule: inv.rootCause.trim(),
        resolution: inv.fixSummary ?? '',
        patternTag: inv.patternTag,
        affectedFeatureId: null,
        needsFeature: true,
        sourceInvestigationId: inv.id
      }),
      memoryCandidate: true
    })
  }
}

function buildKnowledgeDraft(inv: Investigation): KnowledgeDraft {
  const title = inv.patternTag
    ? `Gotcha: ${inv.patternTag}`
    : `Gotcha: ${inv.symptom.slice(0, 80)}`
  const body = [
    `**Symptom:** ${inv.symptom}`,
    `**Root cause:** ${inv.rootCause ?? ''}`,
    `**Fix:** ${inv.fixSummary ?? ''}`,
    inv.patternTag ? `**Pattern tag:** ${inv.patternTag}` : null,
    ``,
    `_Drafted from ${inv.id} (ADR-035). Review before committing via knowledge_create._`
  ]
    .filter((line) => line !== null)
    .join('\n')
  return { type: 'gotcha', title, body, patternTag: inv.patternTag }
}
