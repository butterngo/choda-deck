export type PipelineStage = 'plan' | 'generate' | 'evaluate' | 'done' | 'aborted'
export type PipelineStageStatus = 'running' | 'ready' | 'approved' | 'rejected'
export type EvaluatorMode = 'on' | 'off' | 'auto'

export interface PipelineState {
  sessionId: string
  projectId: string
  taskId: string
  stage: PipelineStage
  stageStatus: PipelineStageStatus | null
  currentIteration: number
  needsEvaluator: boolean
  startedAt: string
}

export interface StartPipelineOpts {
  evaluator: EvaluatorMode
}

export type PipelineAction = 'approve' | 'reject' | 'abort'

export const TERMINAL_STAGES: readonly PipelineStage[] = ['done', 'aborted']

export function isTerminalStage(stage: PipelineStage): boolean {
  return TERMINAL_STAGES.includes(stage)
}

export interface TransitionResult {
  stage: PipelineStage
  stageStatus: PipelineStageStatus | null
}

export function nextStageAfterApprove(
  stage: PipelineStage,
  needsEvaluator: boolean
): PipelineStage {
  if (stage === 'plan') return 'generate'
  if (stage === 'generate') return needsEvaluator ? 'evaluate' : 'done'
  if (stage === 'evaluate') return 'done'
  throw new Error(`nextStageAfterApprove called on terminal stage '${stage}'`)
}
