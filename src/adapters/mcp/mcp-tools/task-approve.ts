import type { InstrumentedServer } from '../instrumented-server'
import { z } from 'zod'
import { textResponse } from './types'
import type { TaskReviewLifecycleOperations } from '../../../core/domain/interfaces/task-review-lifecycle.interface'

export const register = (server: InstrumentedServer, svc: TaskReviewLifecycleOperations): void => {
  server.registerTool(
    'task_approve',
    {
      description:
        'Approve a task in REVIEW status. Closes its active session with handoff {reviewOutcome:"approved"} and transitions the task to DONE. Wrapped in a single DB transaction — both the session close and status flip succeed atomically or roll back together.',
      inputSchema: {
        taskId: z.string().describe('Task ID (must be in REVIEW status with exactly one active session)'),
        note: z.string().optional().describe('Optional approval note recorded in the session handoff')
      }
    },
    async ({ taskId, note }) => {
      const result = svc.approveTask(taskId, note)
      return textResponse(result)
    }
  )
}
