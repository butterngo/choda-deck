import type { InstrumentedServer } from '../instrumented-server'
import { z } from 'zod'
import { textResponse } from './types'
import type { TaskReviewLifecycleOperations } from '../../../core/domain/interfaces/task-review-lifecycle.interface'

export const register = (server: InstrumentedServer, svc: TaskReviewLifecycleOperations): void => {
  server.registerTool(
    'task_reject',
    {
      description:
        'Reject a task in REVIEW status. Closes its active session with handoff {reviewOutcome:"rejected", reviewReason} and transitions the task back to IN-PROGRESS for rework. Wrapped in a single DB transaction.',
      inputSchema: {
        taskId: z.string().describe('Task ID (must be in REVIEW status with exactly one active session)'),
        reason: z.string().min(1).describe('Rejection reason — required, non-empty')
      }
    },
    async ({ taskId, reason }) => {
      const result = svc.rejectTask(taskId, reason)
      return textResponse(result)
    }
  )
}
