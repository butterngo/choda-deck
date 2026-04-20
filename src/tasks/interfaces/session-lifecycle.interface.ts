import type {
  ContextSource,
  Conversation,
  ConversationParticipantType,
  Session,
  SessionCheckpoint,
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
  existingActiveSessions: Session[]
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

export interface CheckpointSessionInput {
  checkpoint: SessionCheckpoint
}

export interface CheckpointSessionResult {
  session: Session
}

export interface ResumeSessionResult {
  session: Session
  checkpoint: SessionCheckpoint | null
  conversations: Conversation[]
  contextSources: ContextSource[]
}

export interface SessionLifecycleOperations {
  startSession(input: StartSessionInput): StartSessionResult
  endSession(id: string, input: EndSessionInput): EndSessionResult
  checkpointSession(id: string, input: CheckpointSessionInput): CheckpointSessionResult
  resumeSession(id: string): ResumeSessionResult
}
