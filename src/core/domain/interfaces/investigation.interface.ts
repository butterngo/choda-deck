import type {
  AddEvidenceInput,
  Evidence,
  Hypothesis,
  HypothesisStatus,
  Investigation,
  ResolveInvestigationInput,
  ResolveInvestigationResult,
  StartInvestigationInput
} from '../investigation-types'

// The full investigation surface exposed by the facade (ADR-035). Mutations are
// validated + transactional in InvestigationLifecycleService; getInvestigation is
// a nested read. All stdio-only — never added to REMOTE_TOOL_ALLOWLIST.
export interface InvestigationOperations {
  startInvestigation(input: StartInvestigationInput): Promise<Investigation>
  addHypothesis(investigationId: string, description: string): Promise<Hypothesis>
  setHypothesisStatus(hypothesisId: string, status: HypothesisStatus): Promise<Hypothesis>
  addEvidence(input: AddEvidenceInput): Promise<Evidence>
  resolveInvestigation(
    id: string,
    input: ResolveInvestigationInput
  ): Promise<ResolveInvestigationResult>
  getInvestigation(id: string): Promise<Investigation | null>
}
