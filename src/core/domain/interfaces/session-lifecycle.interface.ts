import type {
  ContextSource,
  Conversation,
  Session,
  SessionCheckpoint,
  SessionEvent,
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
  /**
   * Session events flagged `memory_candidate=1`, oldest-first.
   * Empty array when the session produced none. Phase 2 of ADR-023:
   * the agent reviews these post-end and decides which (if any) to persist
   * via `memory_write` — Claude self-edit, never auto-written.
   */
  memoryCandidates: SessionEvent[]
  /**
   * Self-edit instruction for the agent, or `''` when `memoryCandidates` is empty.
   * Tells the agent how many candidates exist and how to distill them.
   */
  selfEditPrompt: string
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

export interface AbandonSessionResult {
  session: Session
  closedConversationIds: string[]
}

export interface SessionLifecycleOperations {
  startSession(input: StartSessionInput): StartSessionResult
  endSession(id: string, input: EndSessionInput): EndSessionResult
  /**
   * Failure-path session close — used by autonomous runners (queue) when a task fails AC.
   * Marks session `completed` with `handoff.failureReason`, closes linked conversations,
   * and intentionally **does not** touch the bound task's status (task stays IN-PROGRESS
   * for human review). Distinct from `endSession`, which marks the task DONE.
   */
  abandonSession(id: string, reason: string): AbandonSessionResult
  checkpointSession(id: string, input: CheckpointSessionInput): CheckpointSessionResult
  resumeSession(id: string): ResumeSessionResult
}
