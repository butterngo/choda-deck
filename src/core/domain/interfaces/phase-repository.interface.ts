import type { Phase, CreatePhaseInput, UpdatePhaseInput, DerivedProgress } from '../task-types'

export interface PhaseOperations {
  createPhase(input: CreatePhaseInput): Phase
  updatePhase(id: string, input: UpdatePhaseInput): Phase
  deletePhase(id: string): void
  getPhase(id: string): Phase | null
  findPhases(projectId: string): Phase[]
  getPhaseProgress(phaseId: string): DerivedProgress
}
