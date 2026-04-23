import type {
  ContextSource,
  Conversation,
  Session,
  SessionCheckpoint,
  SessionHandoff
} from '../task-types'

export interface StartSessionInput {
  projectId: string
  workspaceId?: string
  taskId?: string
}

export interface StartSessionResult {
  session: Session
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
