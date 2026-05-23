import type { InboxItem, Task } from '../task-types'

export interface InboxResearchResult {
  inboxId: string
  conversationId: string
  status: 'researching'
}

export interface InboxConvertInput {
  title: string
  priority?: 'critical' | 'high' | 'medium' | 'low'
  labels?: string[]
  body?: string
}

export interface InboxConvertResult {
  inboxId: string
  taskId: string
  task: Task
}

export interface InboxLifecycleOperations {
  startInboxResearch(id: string, researcher: string): Promise<InboxResearchResult>
  convertInboxToTask(id: string, input: InboxConvertInput): Promise<InboxConvertResult>
  archiveInbox(id: string, reason?: string): Promise<InboxItem>
}
