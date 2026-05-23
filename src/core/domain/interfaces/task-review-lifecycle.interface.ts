import type { SessionEvent } from '../task-types'

export interface ApproveTaskResult {
  taskId: string
  status: 'DONE'
  sessionId: string
  memoryCandidates: SessionEvent[]
  selfEditPrompt: string
}

export interface RejectTaskResult {
  taskId: string
  status: 'IN-PROGRESS'
  sessionId: string
  memoryCandidates: SessionEvent[]
  selfEditPrompt: string
}

export interface TaskReviewLifecycleOperations {
  approveTask(taskId: string, note?: string): Promise<ApproveTaskResult>
  rejectTask(taskId: string, reason: string): Promise<RejectTaskResult>
}
