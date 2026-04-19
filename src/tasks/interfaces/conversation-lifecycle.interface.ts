import type { Conversation, ConversationParticipantType } from '../task-types'

export interface OpenConversationInput {
  projectId: string
  title: string
  createdBy: string
  participants?: Array<{ name: string; type: ConversationParticipantType; role?: string }>
  linkedTasks?: string[]
  initialMessage: {
    content: string
    type: 'question' | 'proposal' | 'review'
  }
}

export interface DecideActionInput {
  assignee: string
  description: string
  spawnTask?: {
    title: string
    priority?: 'critical' | 'high' | 'medium' | 'low'
  }
}

export interface DecideConversationInput {
  author: string
  decision: string
  actions?: DecideActionInput[]
}

export interface DecideConversationResultAction {
  id: string
  assignee: string
  description: string
  linkedTaskId: string | null
}

export interface DecideConversationResult {
  conversation: Conversation
  actions: DecideConversationResultAction[]
}

export interface ConversationLifecycleOperations {
  openConversation(input: OpenConversationInput): Conversation
  decideConversation(id: string, input: DecideConversationInput): DecideConversationResult
  closeConversation(id: string): Conversation
  reopenConversation(id: string): Conversation
}
