import type {
  ContextSource,
  ConversationParticipantType,
  Session,
  SessionHandoff
} from '../task-types'

export interface StartSessionInput {
  projectId: string
  workspaceId?: string
  createdBy?: string
  participants?: Array<{ name: string; type: ConversationParticipantType; role?: string }>
}

export interface StartSessionResult {
  session: Session
  conversationId: string
  contextSources: ContextSource[]
}

export interface EndSessionInput {
  handoff: SessionHandoff
  decisionSummary?: string
}

export interface EndSessionResult {
  session: Session
  closedConversationIds: string[]
  taskUpdated: { id: string; title: string; newStatus: 'DONE' } | null
}

export interface SessionLifecycleOperations {
  startSession(input: StartSessionInput): StartSessionResult
  endSession(id: string, input: EndSessionInput): EndSessionResult
}
