import type { Conversation } from '../task-types'

export interface OpenConversationInput {
  projectId: string
  title: string
  createdBy: string
  participants?: Array<{ name: string }>
  linkedTasks?: string[]
  sessionId?: string
  initialMessage: {
    content: string
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

export interface SignoffConversationResult {
  conversation: Conversation
  signedOff: string[]
  /** True when this signoff completed consensus and flipped status to decided. */
  decided: boolean
}

export interface ConversationLifecycleOperations {
  openConversation(input: OpenConversationInput): Promise<Conversation>
  decideConversation(id: string, input: DecideConversationInput): Promise<DecideConversationResult>
  signoffConversation(id: string, name: string): Promise<SignoffConversationResult>
}
