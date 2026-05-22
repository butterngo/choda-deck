import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { SqliteTaskService } from '../sqlite-task-service'
import {
  SessionNotFoundError,
  SessionStatusError,
  TaskLockedBySessionError,
  TaskNotFoundError,
  TaskStatusError
} from './errors'

const TEST_DB = path.join(__dirname, '__test-session-lifecycle__.db')
let svc: SqliteTaskService

beforeEach(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  svc = new SqliteTaskService(TEST_DB)
  svc.ensureProject('proj-s', 'Session Project', '/tmp/s')
})

afterEach(() => {
  svc.close()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
})

describe('startSession', () => {
  it('happy path: creates session + returns active context sources', () => {
    svc.createContextSource({
      projectId: 'proj-s',
      sourceType: 'file',
      sourcePath: 'docs/context.md',
      label: 'Context',
      category: 'what'
    })
    svc.createContextSource({
      projectId: 'proj-s',
      sourceType: 'file',
      sourcePath: 'docs/inactive.md',
      label: 'Inactive',
      category: 'what',
      isActive: false
    })

    const r = svc.startSession({ projectId: 'proj-s', workspaceId: 'ws-a' })

    expect(r.session.status).toBe('active')
    expect(r.session.workspaceId).toBe('ws-a')
    expect(r.contextSources).toHaveLength(1)
    expect(r.contextSources[0].label).toBe('Context')
  })

  it('does not create any conversation on start', () => {
    const r = svc.startSession({ projectId: 'proj-s' })
    expect(svc.findConversations('proj-s')).toHaveLength(0)
    expect(svc.findConversationsByLink('session', r.session.id)).toHaveLength(0)
  })

  it('works without workspaceId', () => {
    const r = svc.startSession({ projectId: 'proj-s' })
    expect(r.session.workspaceId).toBeNull()
    expect(r.session.status).toBe('active')
  })
})

describe('startSession auto-recall (Phase 3 — ADR-023)', () => {
  it('returns empty recalledMemories when no memories exist', () => {
    const task = svc.createTask({ projectId: 'proj-s', title: 'fresh task' })
    const r = svc.startSession({ projectId: 'proj-s', taskId: task.id, workspaceId: 'ws-a' })
    expect(r.recalledMemories).toEqual([])
  })

  it('surfaces a task-scoped memory when session binds the same taskId', () => {
    const task = svc.createTask({ projectId: 'proj-s', title: 'task with memory' })
    const written = svc.writeMemory({
      scopeType: 'task',
      scopeId: task.id,
      memoryType: 'episodic',
      content: 'remember: option A beat option B',
      importance: 60
    })

    const r = svc.startSession({ projectId: 'proj-s', taskId: task.id })
    expect(r.recalledMemories).toHaveLength(1)
    expect(r.recalledMemories[0].id).toBe(written.id)
    expect(r.recalledMemories[0].content).toBe('remember: option A beat option B')
  })

  it('merges across task/workspace/project scopes ranked by importance', () => {
    const task = svc.createTask({ projectId: 'proj-s', title: 'cross-scope task' })
    const mTask = svc.writeMemory({
      scopeType: 'task',
      scopeId: task.id,
      memoryType: 'episodic',
      content: 'task-level note',
      importance: 30
    })
    const mWs = svc.writeMemory({
      scopeType: 'workspace',
      scopeId: 'ws-a',
      memoryType: 'procedural',
      content: 'workspace-level pattern',
      importance: 80
    })
    const mProj = svc.writeMemory({
      scopeType: 'project',
      scopeId: 'proj-s',
      memoryType: 'procedural',
      content: 'project-level convention',
      importance: 50
    })

    const r = svc.startSession({ projectId: 'proj-s', taskId: task.id, workspaceId: 'ws-a' })
    expect(r.recalledMemories.map((m) => m.id)).toEqual([mWs.id, mProj.id, mTask.id])
  })

  it('does not surface memories from a different task', () => {
    const taskA = svc.createTask({ projectId: 'proj-s', title: 'task A' })
    const taskB = svc.createTask({ projectId: 'proj-s', title: 'task B' })
    svc.writeMemory({
      scopeType: 'task',
      scopeId: taskB.id,
      memoryType: 'episodic',
      content: 'belongs to task B',
      importance: 90
    })

    const r = svc.startSession({ projectId: 'proj-s', taskId: taskA.id })
    expect(r.recalledMemories).toEqual([])
  })

  it('bumps recallCount on returned memories', () => {
    const task = svc.createTask({ projectId: 'proj-s', title: 'recall-stat task' })
    const written = svc.writeMemory({
      scopeType: 'task',
      scopeId: task.id,
      memoryType: 'episodic',
      content: 'will be recalled',
      importance: 50
    })
    expect(written.recallCount).toBe(0)

    svc.startSession({ projectId: 'proj-s', taskId: task.id })
    const recalled = svc.recallMemories({ taskId: task.id })
    expect(recalled[0].recallCount).toBeGreaterThanOrEqual(1)
  })
})

describe('endSession', () => {
  it('happy path: active → completed + handoff persisted, no convs by default', () => {
    const started = svc.startSession({ projectId: 'proj-s' })
    const r = svc.endSession(started.session.id, {
      handoff: { resumePoint: 'done for the day', decisions: ['chose option A'] }
    })

    expect(r.session.status).toBe('completed')
    expect(r.session.endedAt).not.toBeNull()
    expect(r.session.handoff?.resumePoint).toBe('done for the day')
    expect(r.closedConversationIds).toEqual([])
  })

  it('closes session-linked conversations opened mid-session', () => {
    const started = svc.startSession({ projectId: 'proj-s' })
    const conv = svc.openConversation({
      projectId: 'proj-s',
      title: 'Mid-session discussion',
      createdBy: 'Butter',
      initialMessage: { content: 'thoughts?', type: 'question' }
    })

    const r = svc.endSession(started.session.id, {
      handoff: { resumePoint: 'done for the day' }
    })

    expect(r.closedConversationIds).toEqual([conv.id])
    const after = svc.getConversation(conv.id)
    expect(after?.status).toBe('closed')
    expect(after?.decisionSummary).toBe('done for the day')
  })

  it('marks linked task DONE when session had a taskId', () => {
    const started = svc.startSession({ projectId: 'proj-s' })
    const task = svc.createTask({ projectId: 'proj-s', title: 'Do X' })
    svc.updateSession(started.session.id, { taskId: task.id })

    const r = svc.endSession(started.session.id, {
      handoff: { resumePoint: 'x' }
    })

    expect(r.taskUpdated).toEqual({ id: task.id, title: 'Do X', newStatus: 'DONE' })
    expect(svc.getTask(task.id)?.status).toBe('DONE')
  })

  it('uses custom decisionSummary when provided', () => {
    const started = svc.startSession({ projectId: 'proj-s' })
    const conv = svc.openConversation({
      projectId: 'proj-s',
      title: 'Mid-session discussion',
      createdBy: 'Butter',
      initialMessage: { content: 'thoughts?', type: 'question' }
    })
    svc.endSession(started.session.id, {
      handoff: { resumePoint: 'r' },
      decisionSummary: 'custom summary'
    })
    expect(svc.getConversation(conv.id)?.decisionSummary).toBe('custom summary')
  })

  it('throws SessionNotFoundError on missing id', () => {
    expect(() => svc.endSession('SESSION-999', { handoff: { resumePoint: 'x' } })).toThrowError(
      SessionNotFoundError
    )
  })

  it('throws SessionStatusError when session already completed', () => {
    const started = svc.startSession({ projectId: 'proj-s' })
    svc.endSession(started.session.id, { handoff: { resumePoint: 'r' } })
    expect(() =>
      svc.endSession(started.session.id, { handoff: { resumePoint: 'again' } })
    ).toThrowError(SessionStatusError)
  })
})

describe('endSession memory candidates (Phase 2 — ADR-023)', () => {
  it('returns empty array + empty prompt when session has zero candidate events', () => {
    const started = svc.startSession({ projectId: 'proj-s' })
    const r = svc.endSession(started.session.id, { handoff: { resumePoint: 'r' } })
    expect(r.memoryCandidates).toEqual([])
    expect(r.selfEditPrompt).toBe('')
  })

  it('ignores non-candidate events even when present', () => {
    const started = svc.startSession({ projectId: 'proj-s' })
    svc.createSessionEvent({
      sessionId: started.session.id,
      eventType: 'tool_call',
      memoryCandidate: false
    })
    svc.createSessionEvent({
      sessionId: started.session.id,
      eventType: 'observation'
      // memoryCandidate omitted — defaults to false
    })
    const r = svc.endSession(started.session.id, { handoff: { resumePoint: 'r' } })
    expect(r.memoryCandidates).toEqual([])
    expect(r.selfEditPrompt).toBe('')
  })

  it('returns single candidate + singular-form prompt mentioning memory_write', () => {
    const started = svc.startSession({ projectId: 'proj-s' })
    const evt = svc.createSessionEvent({
      sessionId: started.session.id,
      eventType: 'decision',
      payloadJson: JSON.stringify({ text: 'picked option A' }),
      memoryCandidate: true
    })

    const r = svc.endSession(started.session.id, { handoff: { resumePoint: 'r' } })
    expect(r.memoryCandidates).toHaveLength(1)
    expect(r.memoryCandidates[0].id).toBe(evt.id)
    expect(r.memoryCandidates[0].memoryCandidate).toBe(true)
    expect(r.selfEditPrompt).toMatch(/1 candidate event\b/)
    expect(r.selfEditPrompt).toContain('memory_write')
  })

  it('returns 3 candidates sorted oldest-first with plural prompt; excludes non-candidates', () => {
    const started = svc.startSession({ projectId: 'proj-s' })
    const e1 = svc.createSessionEvent({
      sessionId: started.session.id,
      eventType: 'decision',
      memoryCandidate: true
    })
    svc.createSessionEvent({
      sessionId: started.session.id,
      eventType: 'observation',
      memoryCandidate: false
    })
    const e2 = svc.createSessionEvent({
      sessionId: started.session.id,
      eventType: 'observation',
      memoryCandidate: true
    })
    const e3 = svc.createSessionEvent({
      sessionId: started.session.id,
      eventType: 'tool_call',
      memoryCandidate: true
    })

    const r = svc.endSession(started.session.id, { handoff: { resumePoint: 'r' } })
    expect(r.memoryCandidates.map((c) => c.id)).toEqual([e1.id, e2.id, e3.id])
    expect(r.selfEditPrompt).toMatch(/3 candidate events\b/)
    expect(r.selfEditPrompt).toContain('memory_write')
    expect(r.selfEditPrompt).toContain('episodic')
    expect(r.selfEditPrompt).toContain('procedural')
  })

  it('does not surface candidates from other sessions', () => {
    const a = svc.startSession({ projectId: 'proj-s' })
    const b = svc.startSession({ projectId: 'proj-s' })
    svc.createSessionEvent({
      sessionId: b.session.id,
      eventType: 'decision',
      memoryCandidate: true
    })

    const r = svc.endSession(a.session.id, { handoff: { resumePoint: 'r' } })
    expect(r.memoryCandidates).toEqual([])
    expect(r.selfEditPrompt).toBe('')
  })
})

describe('endSession structured summary (ADR-028 / TASK-904)', () => {
  const sampleSummary = {
    summary: 'Shipped X, queued Y.',
    tasksDone: ['TASK-1'],
    tasksCreated: ['TASK-2'],
    tasksCancelled: [],
    commits: ['abc123 TASK-1 feat(x): impl'],
    filesChanged: ['src/x.ts (new)'],
    acCoverage: { 'TASK-1': '3/3 verified (lint+vitest+build). 0 deferred.' },
    conversations: [],
    openItems: ['follow-up on Y prefetch']
  }

  it('persists one session_events observation with kind=session_summary when summary provided', () => {
    const started = svc.startSession({ projectId: 'proj-s' })
    const r = svc.endSession(started.session.id, {
      handoff: { resumePoint: 'shipped' },
      summary: sampleSummary
    })

    expect(r.session.status).toBe('completed')
    const events = svc.listSessionEvents(started.session.id, 'observation')
    expect(events).toHaveLength(1)
    const payload = JSON.parse(events[0].payloadJson ?? '{}')
    expect(payload.kind).toBe('session_summary')
    expect(payload.summary).toBe('Shipped X, queued Y.')
    expect(payload.tasksDone).toEqual(['TASK-1'])
    expect(payload.acCoverage).toEqual({ 'TASK-1': '3/3 verified (lint+vitest+build). 0 deferred.' })
    expect(events[0].memoryCandidate).toBe(false)
  })

  it('omits the observation row when summary is not provided (backward compat)', () => {
    const started = svc.startSession({ projectId: 'proj-s' })
    svc.endSession(started.session.id, { handoff: { resumePoint: 'r' } })
    expect(svc.listSessionEvents(started.session.id, 'observation')).toEqual([])
  })

  it('accepts BE extension fields (tasksShipped, branchState, …) when present', () => {
    const started = svc.startSession({ projectId: 'proj-s' })
    svc.endSession(started.session.id, {
      handoff: { resumePoint: 'r' },
      summary: {
        ...sampleSummary,
        tasksShipped: [
          {
            id: 'TASK-1',
            title: 'Impl X',
            commits: ['abc123'],
            files: ['src/x.ts'],
            tests: 12,
            confidence: 0.9
          }
        ],
        branchState: 'feat/x merged to main'
      }
    })
    const events = svc.listSessionEvents(started.session.id, 'observation')
    const payload = JSON.parse(events[0].payloadJson ?? '{}')
    expect(payload.tasksShipped[0].tests).toBe(12)
    expect(payload.branchState).toBe('feat/x merged to main')
  })

  it('rolls back the observation row when the session close fails (atomic)', () => {
    const started = svc.startSession({ projectId: 'proj-s' })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lifecycle = (svc as any).sessionLifecycle
    const orig = lifecycle.sessions.update.bind(lifecycle.sessions)
    lifecycle.sessions.update = () => {
      throw new Error('simulated session update failure')
    }

    expect(() =>
      svc.endSession(started.session.id, {
        handoff: { resumePoint: 'will rollback' },
        summary: sampleSummary
      })
    ).toThrow('simulated session update failure')

    lifecycle.sessions.update = orig

    expect(svc.getSession(started.session.id)?.status).toBe('active')
    expect(svc.listSessionEvents(started.session.id, 'observation')).toEqual([])
  })
})

describe('abandonSession', () => {
  it('happy path: active → completed with handoff.failureReason; task stays IN-PROGRESS', () => {
    const task = svc.createTask({ projectId: 'proj-s', title: 'Bound task' })
    const started = svc.startSession({ projectId: 'proj-s', taskId: task.id })

    const r = svc.abandonSession(started.session.id, 'AC step 2 failed: lint errors')

    expect(r.session.status).toBe('completed')
    expect(r.session.endedAt).not.toBeNull()
    expect(r.session.handoff?.failureReason).toBe('AC step 2 failed: lint errors')
    // Task intentionally untouched — leaves human-review breadcrumb in IN-PROGRESS state.
    expect(svc.getTask(task.id)?.status).toBe('IN-PROGRESS')
  })

  it('preserves prior handoff fields and adds failureReason on top', () => {
    const started = svc.startSession({ projectId: 'proj-s' })
    svc.updateSession(started.session.id, {
      handoff: { resumePoint: 'mid-attempt', decisions: ['picked option A'] }
    })

    const r = svc.abandonSession(started.session.id, 'spawn crashed')

    expect(r.session.handoff?.resumePoint).toBe('mid-attempt')
    expect(r.session.handoff?.decisions).toEqual(['picked option A'])
    expect(r.session.handoff?.failureReason).toBe('spawn crashed')
  })

  it('closes session-linked conversations with abandon-prefixed decisionSummary', () => {
    const started = svc.startSession({ projectId: 'proj-s' })
    const conv = svc.openConversation({
      projectId: 'proj-s',
      title: 'Mid-session discussion',
      createdBy: 'Butter',
      initialMessage: { content: 'thoughts?', type: 'question' }
    })

    const r = svc.abandonSession(started.session.id, 'cost cap exceeded')

    expect(r.closedConversationIds).toEqual([conv.id])
    const after = svc.getConversation(conv.id)
    expect(after?.status).toBe('closed')
    expect(after?.decisionSummary).toBe('Abandoned: cost cap exceeded')
  })

  it('does not touch task when session has no taskId', () => {
    const started = svc.startSession({ projectId: 'proj-s' })
    expect(() => svc.abandonSession(started.session.id, 'no-task abort')).not.toThrow()
    expect(svc.getSession(started.session.id)?.handoff?.failureReason).toBe('no-task abort')
  })

  it('throws SessionNotFoundError on missing id', () => {
    expect(() => svc.abandonSession('SESSION-999', 'r')).toThrowError(SessionNotFoundError)
  })

  it('throws SessionStatusError when session already completed', () => {
    const started = svc.startSession({ projectId: 'proj-s' })
    svc.endSession(started.session.id, { handoff: { resumePoint: 'r' } })
    expect(() => svc.abandonSession(started.session.id, 'r')).toThrowError(SessionStatusError)
  })

  it('throws SessionStatusError when session already abandoned', () => {
    const started = svc.startSession({ projectId: 'proj-s' })
    svc.abandonSession(started.session.id, 'first abort')
    expect(() => svc.abandonSession(started.session.id, 'second abort')).toThrowError(
      SessionStatusError
    )
  })

  it('rolls back transaction on conversation close failure — task and session stay intact', () => {
    const task = svc.createTask({ projectId: 'proj-s', title: 'Atomic' })
    const started = svc.startSession({ projectId: 'proj-s', taskId: task.id })
    const conv = svc.openConversation({
      projectId: 'proj-s',
      title: 'Mid',
      createdBy: 'Butter',
      initialMessage: { content: 'q', type: 'question' }
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lifecycle = (svc as any).sessionLifecycle
    const orig = lifecycle.conversations.update.bind(lifecycle.conversations)
    lifecycle.conversations.update = () => {
      throw new Error('simulated conv update failure')
    }

    expect(() => svc.abandonSession(started.session.id, 'will rollback')).toThrow(
      'simulated conv update failure'
    )

    lifecycle.conversations.update = orig

    expect(svc.getSession(started.session.id)?.status).toBe('active')
    expect(svc.getConversation(conv.id)?.status).toBe('open')
    expect(svc.getTask(task.id)?.status).toBe('IN-PROGRESS')
  })
})

describe('startSession taskId binding', () => {
  it('links task to session and sets it to IN-PROGRESS', () => {
    const task = svc.createTask({ projectId: 'proj-s', title: 'Bound task' })
    const r = svc.startSession({ projectId: 'proj-s', taskId: task.id })

    expect(r.session.taskId).toBe(task.id)
    expect(svc.getTask(task.id)?.status).toBe('IN-PROGRESS')
  })

  it('throws TaskNotFoundError when taskId does not exist', () => {
    expect(() =>
      svc.startSession({ projectId: 'proj-s', taskId: 'TASK-NOPE' })
    ).toThrowError(TaskNotFoundError)
  })

  it('throws TaskStatusError when task is already DONE', () => {
    const task = svc.createTask({ projectId: 'proj-s', title: 'Finished' })
    svc.updateTask(task.id, { status: 'DONE' })

    expect(() => svc.startSession({ projectId: 'proj-s', taskId: task.id })).toThrowError(
      TaskStatusError
    )
  })

  it('throws TaskLockedBySessionError when task is bound to another active session', () => {
    const task = svc.createTask({ projectId: 'proj-s', title: 'Shared' })
    svc.startSession({ projectId: 'proj-s', taskId: task.id })

    expect(() => svc.startSession({ projectId: 'proj-s', taskId: task.id })).toThrowError(
      TaskLockedBySessionError
    )
  })

  it('allows re-binding after the prior session ends', () => {
    const task = svc.createTask({ projectId: 'proj-s', title: 'Handoff' })
    const first = svc.startSession({ projectId: 'proj-s', taskId: task.id })
    svc.endSession(first.session.id, { handoff: { resumePoint: 'paused' } })
    // endSession marked it DONE — reopen before re-binding
    svc.updateTask(task.id, { status: 'READY' })

    const second = svc.startSession({ projectId: 'proj-s', taskId: task.id })
    expect(second.session.taskId).toBe(task.id)
  })

  it('rolls back task status on transaction failure', () => {
    const task = svc.createTask({ projectId: 'proj-s', title: 'Rollback' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lifecycle = (svc as any).sessionLifecycle
    const orig = lifecycle.contextSources.findByProject.bind(lifecycle.contextSources)
    lifecycle.contextSources.findByProject = () => {
      throw new Error('simulated context lookup failure')
    }

    expect(() => svc.startSession({ projectId: 'proj-s', taskId: task.id })).toThrow(
      'simulated context lookup failure'
    )

    lifecycle.contextSources.findByProject = orig

    expect(svc.getTask(task.id)?.status).not.toBe('IN-PROGRESS')
    expect(svc.findSessions('proj-s')).toHaveLength(0)
  })
})

describe('startSession existingActiveSessions', () => {
  it('returns empty array when no prior active sessions', () => {
    const r = svc.startSession({ projectId: 'proj-s' })
    expect(r.existingActiveSessions).toEqual([])
  })

  it('surfaces prior active sessions without blocking new session creation', () => {
    const first = svc.startSession({ projectId: 'proj-s', workspaceId: 'ws-a' })
    const second = svc.startSession({ projectId: 'proj-s', workspaceId: 'ws-b' })

    expect(second.session.id).not.toBe(first.session.id)
    expect(second.existingActiveSessions).toHaveLength(1)
    expect(second.existingActiveSessions[0].id).toBe(first.session.id)
  })

  it('excludes completed sessions from existingActiveSessions', () => {
    const first = svc.startSession({ projectId: 'proj-s' })
    svc.endSession(first.session.id, { handoff: { resumePoint: 'r' } })

    const second = svc.startSession({ projectId: 'proj-s' })
    expect(second.existingActiveSessions).toEqual([])
  })
})

describe('checkpointSession', () => {
  it('happy path: sets checkpoint + checkpointAt, session stays active', () => {
    const started = svc.startSession({ projectId: 'proj-s' })
    const r = svc.checkpointSession(started.session.id, {
      checkpoint: { resumePoint: 'mid-refactor', dirtyFiles: ['src/a.ts'] }
    })

    expect(r.session.status).toBe('active')
    expect(r.session.checkpoint?.resumePoint).toBe('mid-refactor')
    expect(r.session.checkpoint?.dirtyFiles).toEqual(['src/a.ts'])
    expect(r.session.checkpointAt).not.toBeNull()
  })

  it('overwrite on second call, checkpointAt bumps', async () => {
    const started = svc.startSession({ projectId: 'proj-s' })
    const r1 = svc.checkpointSession(started.session.id, {
      checkpoint: { resumePoint: 'first', notes: 'n1' }
    })
    // tick so the timestamp second differs — SQLite datetime('now') has second granularity
    await new Promise((resolve) => setTimeout(resolve, 1100))
    const r2 = svc.checkpointSession(started.session.id, {
      checkpoint: { resumePoint: 'second' }
    })

    expect(r2.session.checkpoint?.resumePoint).toBe('second')
    expect(r2.session.checkpoint?.notes).toBeUndefined()
    expect(r2.session.checkpointAt).not.toBe(r1.session.checkpointAt)
  })

  it('throws SessionNotFoundError on missing id', () => {
    expect(() =>
      svc.checkpointSession('SESSION-999', { checkpoint: { resumePoint: 'r' } })
    ).toThrowError(SessionNotFoundError)
  })

  it('throws SessionStatusError on completed session', () => {
    const started = svc.startSession({ projectId: 'proj-s' })
    svc.endSession(started.session.id, { handoff: { resumePoint: 'r' } })
    expect(() =>
      svc.checkpointSession(started.session.id, { checkpoint: { resumePoint: 'r' } })
    ).toThrowError(SessionStatusError)
  })
})

describe('resumeSession', () => {
  it('returns session + null checkpoint + linked conversations + context sources', () => {
    svc.createContextSource({
      projectId: 'proj-s',
      sourceType: 'file',
      sourcePath: 'docs/ctx.md',
      label: 'Ctx',
      category: 'what'
    })
    const started = svc.startSession({ projectId: 'proj-s' })
    const conv = svc.openConversation({
      projectId: 'proj-s',
      title: 'Mid-session discussion',
      createdBy: 'Butter',
      initialMessage: { content: 'thoughts?', type: 'question' }
    })

    const r = svc.resumeSession(started.session.id)
    expect(r.session.id).toBe(started.session.id)
    expect(r.checkpoint).toBeNull()
    expect(r.conversations.map((c) => c.id)).toEqual([conv.id])
    expect(r.contextSources.map((c) => c.label)).toEqual(['Ctx'])
  })

  it('returns checkpoint when one exists', () => {
    const started = svc.startSession({ projectId: 'proj-s' })
    svc.checkpointSession(started.session.id, {
      checkpoint: { resumePoint: 'pause', lastCommit: 'abc123' }
    })

    const r = svc.resumeSession(started.session.id)
    expect(r.checkpoint?.resumePoint).toBe('pause')
    expect(r.checkpoint?.lastCommit).toBe('abc123')
  })

  it('works on completed sessions (read-only replay)', () => {
    const started = svc.startSession({ projectId: 'proj-s' })
    svc.endSession(started.session.id, { handoff: { resumePoint: 'r' } })

    const r = svc.resumeSession(started.session.id)
    expect(r.session.status).toBe('completed')
  })

  it('throws SessionNotFoundError on missing id', () => {
    expect(() => svc.resumeSession('SESSION-999')).toThrowError(SessionNotFoundError)
  })
})

describe('transaction rollback (atomicity)', () => {
  it('rolls back session creation when context-source lookup fails mid-start', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lifecycle = (svc as any).sessionLifecycle
    const orig = lifecycle.contextSources.findByProject.bind(lifecycle.contextSources)
    lifecycle.contextSources.findByProject = () => {
      throw new Error('simulated context lookup failure')
    }

    expect(() => svc.startSession({ projectId: 'proj-s' })).toThrow(
      'simulated context lookup failure'
    )

    lifecycle.contextSources.findByProject = orig

    expect(svc.findSessions('proj-s')).toHaveLength(0)
  })

  it('rolls back session status + conv close when task update fails mid-end', () => {
    const started = svc.startSession({ projectId: 'proj-s' })
    const conv = svc.openConversation({
      projectId: 'proj-s',
      title: 'Mid-session discussion',
      createdBy: 'Butter',
      initialMessage: { content: 'thoughts?', type: 'question' }
    })
    const task = svc.createTask({ projectId: 'proj-s', title: 'Y' })
    svc.updateSession(started.session.id, { taskId: task.id })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lifecycle = (svc as any).sessionLifecycle
    const orig = lifecycle.tasks.update.bind(lifecycle.tasks)
    lifecycle.tasks.update = () => {
      throw new Error('simulated task failure')
    }

    expect(() => svc.endSession(started.session.id, { handoff: { resumePoint: 'x' } })).toThrow(
      'simulated task failure'
    )

    lifecycle.tasks.update = orig

    expect(svc.getSession(started.session.id)?.status).toBe('active')
    expect(svc.getConversation(conv.id)?.status).toBe('open')
    expect(svc.getTask(task.id)?.status).not.toBe('DONE')
  })
})
