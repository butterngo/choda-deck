import type { PipelineStage, PipelineStageStatus } from './pipeline-state'

export class HarnessError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'HarnessError'
  }
}

export class InvalidPipelineTransitionError extends HarnessError {
  constructor(
    public readonly fromStage: PipelineStage,
    public readonly fromStatus: PipelineStageStatus | null,
    public readonly action: string
  ) {
    super(
      'INVALID_PIPELINE_TRANSITION',
      `Cannot ${action} from stage='${fromStage}' status='${fromStatus ?? 'null'}'`
    )
    this.name = 'InvalidPipelineTransitionError'
  }
}

export class PipelineCapExceededError extends HarnessError {
  constructor(public readonly max: number) {
    super('PIPELINE_CAP_EXCEEDED', `Maximum ${max} concurrent pipelines reached`)
    this.name = 'PipelineCapExceededError'
  }
}

export class PipelineSessionNotFoundError extends HarnessError {
  constructor(public readonly sessionId: string) {
    super('PIPELINE_SESSION_NOT_FOUND', `No active pipeline for session ${sessionId}`)
    this.name = 'PipelineSessionNotFoundError'
  }
}

export interface InteractiveConvPayload {
  owner_type: 'interactive'
  owner_session_id: string | null
  owner_task_id: string | null
  started_at: string
}

export class InteractiveConversationBlockingError extends HarnessError {
  constructor(public readonly payload: InteractiveConvPayload) {
    super(
      'INTERACTIVE_CONV_BLOCKING',
      `Interactive conversation on session ${payload.owner_session_id ?? 'unknown'} blocks pipeline start`
    )
    this.name = 'InteractiveConversationBlockingError'
  }
}

export class TaskNotFoundError extends HarnessError {
  constructor(public readonly taskId: string) {
    super('TASK_NOT_FOUND', `Task ${taskId} not found`)
    this.name = 'TaskNotFoundError'
  }
}
