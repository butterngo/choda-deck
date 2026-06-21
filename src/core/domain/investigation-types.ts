// Investigation domain object (ADR-035) — a durable, cross-session container for
// nonlinear debugging state. See docs/knowledge/ADR-035-investigation-domain-object.md.

export type InvestigationStatus = 'exploring' | 'confirmed' | 'resolved'
export type HypothesisStatus = 'testing' | 'ruled_out' | 'confirmed'
export type EvidenceType = 'screenshot' | 'log' | 'network' | 'code_snippet'

export interface Hypothesis {
  id: string
  investigationId: string
  description: string
  status: HypothesisStatus
  createdAt: string
}

export interface Evidence {
  id: string
  investigationId: string
  // Evidence attaches to the investigation as a whole, or to a specific hypothesis.
  hypothesisId: string | null
  type: EvidenceType
  // `ref` is a by-reference locator (file:line / path / URL). `snapshot` is the
  // captured value — the observed runtime output itself, ephemeral at the source
  // (ADR-035 evidence-by-value, TASK-1167). Either or both may be present.
  ref: string
  snapshot: string | null
  note: string | null
  createdAt: string
}

export interface Investigation {
  id: string
  symptom: string
  status: InvestigationStatus
  taskId: string | null
  sessionId: string | null
  rootCause: string | null
  fixSummary: string | null
  patternTag: string | null
  createdAt: string
  resolvedAt: string | null
  // Populated by getInvestigation (nested read); empty on a bare row fetch.
  hypotheses: Hypothesis[]
  evidence: Evidence[]
}

export interface StartInvestigationInput {
  symptom: string
  taskId?: string | null
  sessionId?: string | null
}

export interface AddEvidenceInput {
  investigationId: string
  hypothesisId?: string | null
  type: EvidenceType
  ref: string
  snapshot?: string | null
  note?: string | null
}

export interface ResolveInvestigationInput {
  rootCause: string
  fixSummary: string
  patternTag?: string | null
}

// The human-gated knowledge_create(gotcha) draft returned at resolve. NOT written
// to the knowledge layer by the resolve transaction — the human commits it (ADR-035).
export interface KnowledgeDraft {
  type: 'gotcha'
  title: string
  body: string
  patternTag: string | null
}

export interface ResolveInvestigationResult {
  investigation: Investigation
  knowledgeDraft: KnowledgeDraft
}
