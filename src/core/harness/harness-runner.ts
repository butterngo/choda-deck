import type { SessionRepository } from '../../tasks/repositories/session-repository'
import type { ConversationRepository } from '../../tasks/repositories/conversation-repository'
import type { TaskRepository } from '../../tasks/repositories/task-repository'
import {
  isTerminalStage,
  nextStageAfterApprove,
  type EvaluatorMode,
  type PipelineAction,
  type PipelineStage,
  type PipelineStageStatus,
  type PipelineState,
  type StartPipelineOpts
} from './pipeline-state'
import {
  InteractiveConversationBlockingError,
  InvalidPipelineTransitionError,
  PipelineCapExceededError,
  PipelineSessionNotFoundError,
  TaskNotFoundError
} from './errors'

export const MAX_CONCURRENT_SESSIONS = 3

interface ApprovalLogger {
  log(input: {
    sessionId: string
    stage: PipelineStage
    iteration: number
    decision: PipelineAction
    feedback?: string
  }): void
}

interface HarnessRunnerDeps {
  sessions: SessionRepository
  conversations: ConversationRepository
  tasks: TaskRepository
  approvals: ApprovalLogger
  now?: () => string
  evaluatorDecider?: (taskId: string, mode: EvaluatorMode) => boolean
}

export class HarnessRunner {
  private readonly sessionStates: Map<string, PipelineState> = new Map()
  private readonly now: () => string

  constructor(private readonly deps: HarnessRunnerDeps) {
    this.now = deps.now ?? (() => new Date().toISOString())
    this.hydrateFromDb()
  }

  startPipeline(taskId: string, opts: StartPipelineOpts): PipelineState {
    if (this.sessionStates.size >= MAX_CONCURRENT_SESSIONS) {
      throw new PipelineCapExceededError(MAX_CONCURRENT_SESSIONS)
    }

    const task = this.deps.tasks.get(taskId)
    if (!task) throw new TaskNotFoundError(taskId)

    this.assertNoInteractiveConversation(task.projectId)

    const needsEvaluator = this.resolveEvaluator(taskId, opts.evaluator)
    const session = this.deps.sessions.create({
      projectId: task.projectId,
      taskId,
      status: 'active',
      startedAt: this.now()
    })

    const state: PipelineState = {
      sessionId: session.id,
      projectId: task.projectId,
      taskId,
      stage: 'plan',
      stageStatus: 'running',
      currentIteration: 0,
      needsEvaluator,
      startedAt: session.startedAt
    }
    this.sessionStates.set(session.id, state)
    this.persistStage(session.id, 'plan', 'running', needsEvaluator, 0)
    return state
  }

  approveStage(sessionId: string): PipelineState {
    const state = this.requireState(sessionId)
    if (state.stageStatus !== 'ready') {
      throw new InvalidPipelineTransitionError(state.stage, state.stageStatus, 'approve')
    }

    this.deps.approvals.log({
      sessionId,
      stage: state.stage,
      iteration: state.currentIteration,
      decision: 'approve'
    })

    const next = nextStageAfterApprove(state.stage, state.needsEvaluator)
    const nextStatus: PipelineStageStatus | null = next === 'done' ? null : 'running'
    const iteration = next === state.stage ? state.currentIteration : 0

    state.stage = next
    state.stageStatus = nextStatus
    state.currentIteration = iteration
    this.persistStage(sessionId, next, nextStatus, state.needsEvaluator, iteration)

    if (isTerminalStage(next)) this.sessionStates.delete(sessionId)
    return state
  }

  rejectStage(sessionId: string, feedback: string): PipelineState {
    const state = this.requireState(sessionId)
    if (state.stageStatus !== 'ready') {
      throw new InvalidPipelineTransitionError(state.stage, state.stageStatus, 'reject')
    }

    this.deps.approvals.log({
      sessionId,
      stage: state.stage,
      iteration: state.currentIteration,
      decision: 'reject',
      feedback
    })

    state.stageStatus = 'rejected'
    state.currentIteration += 1
    this.persistStage(
      sessionId,
      state.stage,
      'rejected',
      state.needsEvaluator,
      state.currentIteration
    )
    return state
  }

  markStageReady(sessionId: string): PipelineState {
    const state = this.requireState(sessionId)
    if (state.stageStatus !== 'running') {
      throw new InvalidPipelineTransitionError(
        state.stage,
        state.stageStatus,
        'markStageReady'
      )
    }
    state.stageStatus = 'ready'
    this.persistStage(
      sessionId,
      state.stage,
      'ready',
      state.needsEvaluator,
      state.currentIteration
    )
    return state
  }

  abort(sessionId: string): PipelineState {
    const state = this.requireState(sessionId)
    if (isTerminalStage(state.stage)) {
      throw new InvalidPipelineTransitionError(state.stage, state.stageStatus, 'abort')
    }

    this.deps.approvals.log({
      sessionId,
      stage: state.stage,
      iteration: state.currentIteration,
      decision: 'abort'
    })

    state.stage = 'aborted'
    state.stageStatus = null
    this.persistStage(sessionId, 'aborted', null, state.needsEvaluator, state.currentIteration)
    this.sessionStates.delete(sessionId)
    return state
  }

  getState(sessionId: string): PipelineState | null {
    return this.sessionStates.get(sessionId) ?? null
  }

  activeCount(): number {
    return this.sessionStates.size
  }

  private requireState(sessionId: string): PipelineState {
    const s = this.sessionStates.get(sessionId)
    if (!s) throw new PipelineSessionNotFoundError(sessionId)
    return s
  }

  private assertNoInteractiveConversation(projectId: string): void {
    const blockers = this.deps.conversations.findActiveByOwnerType(projectId, 'interactive')
    if (blockers.length === 0) return
    const b = blockers[0]
    const ownerSession = b.ownerSessionId ? this.deps.sessions.get(b.ownerSessionId) : null
    throw new InteractiveConversationBlockingError({
      owner_type: 'interactive',
      owner_session_id: b.ownerSessionId,
      owner_task_id: ownerSession?.taskId ?? null,
      started_at: b.startedAt
    })
  }

  private resolveEvaluator(taskId: string, mode: EvaluatorMode): boolean {
    if (mode === 'on') return true
    if (mode === 'off') return false
    if (this.deps.evaluatorDecider) return this.deps.evaluatorDecider(taskId, mode)
    return false
  }

  private persistStage(
    sessionId: string,
    stage: PipelineStage,
    stageStatus: PipelineStageStatus | null,
    needsEvaluator: boolean,
    currentIteration: number
  ): void {
    this.deps.sessions.updatePipelineStage(sessionId, {
      stage,
      stageStatus,
      needsEvaluator,
      currentIteration
    })
  }

  private hydrateFromDb(): void {
    const active = this.deps.sessions.findActivePipelines()
    for (const row of active) {
      this.sessionStates.set(row.sessionId, {
        sessionId: row.sessionId,
        projectId: row.projectId,
        taskId: row.taskId,
        stage: row.stage,
        stageStatus: row.stageStatus,
        currentIteration: row.currentIteration,
        needsEvaluator: row.needsEvaluator,
        startedAt: row.startedAt
      })
    }
  }
}
