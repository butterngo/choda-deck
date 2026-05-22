import type Database from 'better-sqlite3'
import type { SessionRepository } from '../repositories/session-repository'
import type { ContextSourceRepository } from '../repositories/context-source-repository'
import type { ConversationRepository } from '../repositories/conversation-repository'
import type { TaskRepository } from '../repositories/task-repository'
import type { SessionEventRepository } from '../repositories/session-event-repository'
import type { AgentMemory, SessionEvent } from '../task-types'
import type { MemoryRecallInput } from '../interfaces/agent-memory-operations.interface'
import type {
  AbandonSessionResult,
  CheckpointSessionInput,
  CheckpointSessionResult,
  EndSessionInput,
  EndSessionResult,
  ResumeSessionResult,
  SessionLifecycleOperations,
  SessionSummaryPayload,
  StartSessionInput,
  StartSessionResult
} from '../interfaces/session-lifecycle.interface'
import { findAcItems } from './ac-check'

export type RecallMemoriesFn = (input: MemoryRecallInput) => AgentMemory[]
import { now } from '../repositories/shared'
import {
  SessionNotFoundError,
  SessionStatusError,
  TaskLockedBySessionError,
  TaskNotFoundError,
  TaskStatusError
} from './errors'

export class SessionLifecycleService implements SessionLifecycleOperations {
  constructor(
    private readonly db: Database.Database,
    private readonly sessions: SessionRepository,
    private readonly contextSources: ContextSourceRepository,
    private readonly conversations: ConversationRepository,
    private readonly tasks: TaskRepository,
    private readonly sessionEvents: SessionEventRepository,
    private readonly recallMemoriesFn: RecallMemoriesFn
  ) {}

  startSession(input: StartSessionInput): StartSessionResult {
    const tx = this.db.transaction((): StartSessionResult => {
      const existingActiveSessions = this.sessions.findByProject(input.projectId, 'active')

      if (input.taskId) {
        const task = this.tasks.get(input.taskId)
        if (!task) throw new TaskNotFoundError(input.taskId)
        if (task.status === 'DONE') {
          throw new TaskStatusError(
            input.taskId,
            task.status,
            'cannot start a session on a DONE task — reopen it first'
          )
        }
        const lockingSession = existingActiveSessions.find((s) => s.taskId === input.taskId)
        if (lockingSession) throw new TaskLockedBySessionError(input.taskId, lockingSession.id)
      }

      const session = this.sessions.create({
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        taskId: input.taskId,
        startedAt: now(),
        status: 'active'
      })

      if (input.taskId) {
        this.tasks.update(input.taskId, { status: 'IN-PROGRESS' })
      }

      const contextSources = this.contextSources.findByProject(input.projectId, true)

      const recalledMemories = this.recallMemoriesFn({
        taskId: input.taskId,
        workspaceId: input.workspaceId,
        projectId: input.projectId
      })

      return { session, contextSources, existingActiveSessions, recalledMemories }
    })
    return tx()
  }

  endSession(id: string, input: EndSessionInput): EndSessionResult {
    const tx = this.db.transaction((): EndSessionResult => {
      const session = this.sessions.get(id)
      if (!session) throw new SessionNotFoundError(id)
      if (session.status !== 'active') {
        throw new SessionStatusError(id, session.status, 'only active sessions can end')
      }

      const endedAt = now()
      const decisionSummary =
        input.decisionSummary ?? input.handoff.resumePoint ?? 'Session ended'

      const closedConversationIds: string[] = []
      const linkedConvs = this.conversations.findByLink('session', id)
      for (const conv of linkedConvs) {
        if (conv.status === 'closed') continue
        this.conversations.update(conv.id, {
          status: 'closed',
          decisionSummary,
          closedAt: endedAt
        })
        closedConversationIds.push(conv.id)
      }

      let taskUpdated: EndSessionResult['taskUpdated'] = null
      if (session.taskId) {
        const task = this.tasks.get(session.taskId)
        if (task) {
          this.tasks.update(session.taskId, { status: 'DONE' })
          taskUpdated = { id: task.id, title: task.title, newStatus: 'DONE' }
        }
      }

      const updated = this.sessions.update(id, {
        status: 'completed',
        endedAt,
        handoff: input.handoff
      })

      if (input.summary) {
        const merged = aggregateSessionSummary(this.sessionEvents, this.tasks, id, input.summary)
        this.sessionEvents.create({
          sessionId: id,
          eventType: 'observation',
          payloadJson: JSON.stringify({ kind: 'session_summary', ...merged }),
          memoryCandidate: false
        })
      }

      const memoryCandidates = this.sessionEvents.listMemoryCandidates(id)
      const selfEditPrompt = buildSelfEditPrompt(memoryCandidates)

      return { session: updated, closedConversationIds, taskUpdated, memoryCandidates, selfEditPrompt }
    })
    return tx()
  }

  abandonSession(id: string, reason: string): AbandonSessionResult {
    const tx = this.db.transaction((): AbandonSessionResult => {
      const session = this.sessions.get(id)
      if (!session) throw new SessionNotFoundError(id)
      if (session.status !== 'active') {
        throw new SessionStatusError(id, session.status, 'only active sessions can be abandoned')
      }

      const endedAt = now()
      const decisionSummary = `Abandoned: ${reason}`

      const closedConversationIds: string[] = []
      const linkedConvs = this.conversations.findByLink('session', id)
      for (const conv of linkedConvs) {
        if (conv.status === 'closed') continue
        this.conversations.update(conv.id, {
          status: 'closed',
          decisionSummary,
          closedAt: endedAt
        })
        closedConversationIds.push(conv.id)
      }

      // Intentionally do NOT touch session.taskId — task stays IN-PROGRESS for human review.
      const handoff = { ...(session.handoff ?? {}), failureReason: reason }
      const updated = this.sessions.update(id, {
        status: 'completed',
        endedAt,
        handoff
      })

      return { session: updated, closedConversationIds }
    })
    return tx()
  }

  checkpointSession(id: string, input: CheckpointSessionInput): CheckpointSessionResult {
    const session = this.sessions.get(id)
    if (!session) throw new SessionNotFoundError(id)
    if (session.status !== 'active') {
      throw new SessionStatusError(id, session.status, 'only active sessions can checkpoint')
    }

    const updated = this.sessions.update(id, {
      checkpoint: input.checkpoint,
      checkpointAt: now()
    })
    return { session: updated }
  }

  resumeSession(id: string): ResumeSessionResult {
    const session = this.sessions.get(id)
    if (!session) throw new SessionNotFoundError(id)

    const conversations = this.conversations.findByLink('session', id)
    const contextSources = this.contextSources.findByProject(session.projectId, true)

    return {
      session,
      checkpoint: session.checkpoint,
      conversations,
      contextSources
    }
  }
}

/**
 * ADR-029 step 4 (TASK-913) — auto-fill `filesChanged` + `acCoverage` from the
 * channels 1+2 observation rows of the current session before persisting the
 * `kind='session_summary'` row. Merge rule: **AI input wins**. The aggregator
 * only fills gaps and appends "+ K auto-detected" suffixes when AI provided
 * an `acCoverage[taskId]` and ac_check events also exist for that taskId.
 *
 * Pure with respect to its repository arguments — no side effects. Designed to
 * run inside the same `db.transaction(...)` as the `session_summary` INSERT so
 * a SELECT failure mid-aggregate rolls back the entire end-session payload.
 */
export function aggregateSessionSummary(
  sessionEvents: SessionEventRepository,
  tasks: TaskRepository,
  sessionId: string,
  summary: SessionSummaryPayload
): SessionSummaryPayload {
  const events = sessionEvents.listBySession(sessionId, 'observation')

  const fileStatsByPath = new Map<string, { added: number; removed: number }>()
  const acEvidencesByTask = new Map<string, string[]>()

  for (const evt of events) {
    const payload = parseObservationPayload(evt.payloadJson)
    if (!payload) continue
    if (payload.kind === 'file_modified' && typeof payload.path === 'string') {
      const prev = fileStatsByPath.get(payload.path) ?? { added: 0, removed: 0 }
      prev.added += typeof payload.linesAdded === 'number' ? payload.linesAdded : 0
      prev.removed += typeof payload.linesRemoved === 'number' ? payload.linesRemoved : 0
      fileStatsByPath.set(payload.path, prev)
    } else if (payload.kind === 'ac_check' && typeof payload.taskId === 'string') {
      const list = acEvidencesByTask.get(payload.taskId) ?? []
      list.push(typeof payload.evidence === 'string' ? payload.evidence : '')
      acEvidencesByTask.set(payload.taskId, list)
    }
  }

  const aiFiles = summary.filesChanged ?? []
  const aiPaths = new Set<string>()
  for (const entry of aiFiles) {
    const split = entry.indexOf(' (')
    aiPaths.add(split >= 0 ? entry.slice(0, split) : entry)
  }
  const derivedFiles: string[] = []
  for (const [p, stats] of fileStatsByPath) {
    if (aiPaths.has(p)) continue
    derivedFiles.push(`${p} (+${stats.added}, -${stats.removed})`)
  }
  const mergedFilesChanged = [...aiFiles, ...derivedFiles]

  const aiAcCoverage = summary.acCoverage ?? {}
  const mergedAcCoverage: Record<string, string> = { ...aiAcCoverage }
  for (const [taskId, evidences] of acEvidencesByTask) {
    const n = evidences.length
    const evidenceSummary = evidences.filter((e) => e.length > 0).join('; ')
    const task = tasks.get(taskId)
    const m = task ? findAcItems(task.body ?? '').length : n
    if (aiAcCoverage[taskId]) {
      mergedAcCoverage[taskId] = `${aiAcCoverage[taskId]} + ${n} auto-detected`
    } else {
      mergedAcCoverage[taskId] = `${n}/${m} verified (${evidenceSummary})`
    }
  }

  return {
    ...summary,
    filesChanged: mergedFilesChanged,
    acCoverage: mergedAcCoverage
  }
}

function parseObservationPayload(json: string | null): Record<string, unknown> | null {
  if (!json) return null
  try {
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>
  } catch {
    /* malformed payload — skip */
  }
  return null
}

export function buildSelfEditPrompt(candidates: SessionEvent[]): string {
  if (candidates.length === 0) return ''
  const n = candidates.length
  const word = n === 1 ? 'event' : 'events'
  return (
    `Review these ${n} candidate ${word} from the session. ` +
    `Call memory_write for 1-3 entries worth remembering across sessions — ` +
    `use type='episodic' with scope='task' for task-specific learnings, ` +
    `or type='procedural' with scope='project' or 'workspace' for reusable patterns. ` +
    `Skip entirely if nothing here is worth keeping.`
  )
}
