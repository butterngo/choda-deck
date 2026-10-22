import type {
  DeployCheckRow,
  DeployChecks,
  SetDeployCheckInput
} from '../repositories/deploy-check-repository'

// TASK-2605 — deploy checklist ticks per goal and environment.
export interface DeployCheckOperations {
  setDeployCheck(input: SetDeployCheckInput): Promise<DeployCheckRow>
  listDeployChecks(goalTaskId: string): Promise<DeployChecks>
}
