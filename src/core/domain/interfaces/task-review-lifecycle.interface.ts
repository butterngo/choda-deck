export interface ApproveTaskResult {
  taskId: string
  status: 'DONE'
  sessionId: string
}

export interface RejectTaskResult {
  taskId: string
  status: 'IN-PROGRESS'
  sessionId: string
}

export interface TaskReviewLifecycleOperations {
  approveTask(taskId: string, note?: string): ApproveTaskResult
  rejectTask(taskId: string, reason: string): RejectTaskResult
}
