import type {
  AgentMemory,
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
  /**
   * Memories matching the session scopes (task → workspace → project), ranked by
   * importance, merged + deduped by `SqliteTaskService.recallMemories`. Empty when
   * nothing matches. Phase 3 of ADR-023: the agent gets cross-session continuity
   * surfaced for free without an explicit `memory_recall` call. `user` scope is
   * intentionally omitted — StartSessionInput has no `userId`.
   */
  recalledMemories: AgentMemory[]
}

/**
 * Structured session-summary payload — ADR-028 (TASK-904) + ADR-029 step 4
 * (TASK-913). When provided to `endSession`, persisted as a `session_events`
 * row with `event_type='observation'` and `payload.kind='session_summary'`,
 * atomic with session close.
 *
 * FE base fields required; BE extension fields optional. Schema enforcement
 * happens at the MCP boundary (Zod in session-tools.ts) — the service trusts
 * the type.
 *
 * `filesChanged` + `acCoverage` are AI-optional — when omitted, the server's
 * aggregator (see `aggregateSessionSummary`) fills them from channel 1
 * (`kind='file_modified'`) and channel 2 (`kind='ac_check'`) rows of the
 * current session. AI-provided entries always win; the aggregator only fills
 * gaps and appends `+ K auto-detected` to AI-provided `acCoverage` values.
 */
export interface SessionSummaryPayload {
  summary: string
  tasksDone: string[]
  tasksCreated: string[]
  tasksCancelled: string[]
  commits: string[]
  filesChanged?: string[]
  acCoverage?: Record<string, string>
  conversations: string[]
  openItems: string[]
  tasksShipped?: Array<{
    id: string
    title: string
    commits: string[]
    files: string[]
    tests: number
    confidence: number
  }>
  tasksNotDone?: Array<{ id: string; reason: string }>
  testCoverageSummary?: string
  outstandingRisks?: string[]
  branchState?: string
}

export interface EndSessionInput {
  handoff: SessionHandoff
  decisionSummary?: string
  /**
   * Optional structured session-summary payload (ADR-028). When provided,
   * `endSession` writes one `session_events` observation row with
   * `payload.kind='session_summary'`, atomic with session close. Omitting
   * preserves full backward compat — no event row is created.
   */
  summary?: SessionSummaryPayload
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
  startSession(input: StartSessionInput): Promise<StartSessionResult>
  endSession(id: string, input: EndSessionInput): Promise<EndSessionResult>
  /**
   * Failure-path session close. Marks session `completed` with `handoff.failureReason`,
   * closes linked conversations, and intentionally **does not** touch the bound task's
   * status (task stays IN-PROGRESS for human review). Distinct from `endSession`, which
   * marks the task DONE.
   */
  abandonSession(id: string, reason: string): Promise<AbandonSessionResult>
  checkpointSession(id: string, input: CheckpointSessionInput): Promise<CheckpointSessionResult>
  resumeSession(id: string): Promise<ResumeSessionResult>
}
