import type Database from 'better-sqlite3'
import type { SessionRepository } from '../repositories/session-repository'
import type { TaskRepository } from '../repositories/task-repository'
import type {
  ApproveTaskResult,
  RejectTaskResult,
  TaskReviewLifecycleOperations
} from '../interfaces/task-review-lifecycle.interface'
import type { SessionHandoff } from '../task-types'
import type { SessionLifecycleService } from './session-lifecycle-service'
import { LifecycleError, TaskNotFoundError, TaskStatusError } from './errors'

export class ReviewSessionResolutionError extends LifecycleError {
  constructor(taskId: string, message: string) {
    super('REVIEW_SESSION_RESOLUTION_FAILED', `Task ${taskId}: ${message}`)
    this.name = 'ReviewSessionResolutionError'
  }
}

export class TaskReviewLifecycleService implements TaskReviewLifecycleOperations {
  constructor(
    private readonly db: Database.Database,
    private readonly tasks: TaskRepository,
    private readonly sessions: SessionRepository,
    private readonly sessionLifecycle: SessionLifecycleService
  ) {}

  approveTask(taskId: string, note?: string): ApproveTaskResult {
    const tx = this.db.transaction((): ApproveTaskResult => {
      const sessionId = this.guardAndResolveSession(taskId, 'approve')
      const handoff: SessionHandoff = {
        reviewOutcome: 'approved',
        resumePoint: note ? `Approved: ${note}` : 'Approved after review',
        ...(note ? { decisions: [`Approved: ${note}`] } : {})
      }
      this.sessionLifecycle.endSession(sessionId, { handoff })
      // endSession sets task → DONE when session has taskId; re-apply explicitly so the
      // composite's final state is self-documenting and won't drift if endSession changes.
      this.tasks.update(taskId, { status: 'DONE' })
      return { taskId, status: 'DONE', sessionId }
    })
    return tx()
  }

  rejectTask(taskId: string, reason: string): RejectTaskResult {
    const tx = this.db.transaction((): RejectTaskResult => {
      const sessionId = this.guardAndResolveSession(taskId, 'reject')
      const handoff: SessionHandoff = {
        reviewOutcome: 'rejected',
        reviewReason: reason,
        resumePoint: `Rejected: ${reason}`,
        decisions: [`Rejected: ${reason}`]
      }
      this.sessionLifecycle.endSession(sessionId, { handoff })
      // endSession unconditionally sets task → DONE; override to IN-PROGRESS within
      // the same outer transaction so the task lands back in the work queue.
      this.tasks.update(taskId, { status: 'IN-PROGRESS' })
      return { taskId, status: 'IN-PROGRESS', sessionId }
    })
    return tx()
  }

  private guardAndResolveSession(taskId: string, op: 'approve' | 'reject'): string {
    const task = this.tasks.get(taskId)
    if (!task) throw new TaskNotFoundError(taskId)
    if (task.status !== 'REVIEW') {
      throw new TaskStatusError(taskId, task.status, `not in REVIEW — cannot ${op}`)
    }
    const actives = this.sessions.findActiveByTask(taskId)
    if (actives.length === 0) {
      throw new ReviewSessionResolutionError(taskId, 'no active session bound to task')
    }
    if (actives.length > 1) {
      throw new ReviewSessionResolutionError(
        taskId,
        `${actives.length} active sessions bound to task — race detected`
      )
    }
    return actives[0].id
  }
}
