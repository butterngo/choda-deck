import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { SqliteTaskService } from '../sqlite-task-service'
import { draftGotchaFromDecision } from './session-lifecycle-service'
import {
  SessionNotFoundError,
  SessionStatusError,
  TaskLockedBySessionError,
  TaskNotFoundError,
  TaskStatusError
} from './errors'

const TEST_DB = path.join(__dirname, '__test-session-lifecycle__.db')
let svc: SqliteTaskService

beforeEach(async () => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  svc = new SqliteTaskService(TEST_DB)
  await svc.ensureProject('proj-s', 'Session Project', '/tmp/s')
})

afterEach(async () => {
  await svc.close()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
})

describe('startSession', () => {
  it('happy path: creates session + returns active context sources', async () => {
    await svc.createContextSource({
      projectId: 'proj-s',
      sourceType: 'file',
      sourcePath: 'docs/context.md',
      label: 'Context',
      category: 'what'
    })
    await svc.createContextSource({
      projectId: 'proj-s',
      sourceType: 'file',
      sourcePath: 'docs/inactive.md',
      label: 'Inactive',
      category: 'what',
      isActive: false
    })

    const r = await svc.startSession({ projectId: 'proj-s', workspaceId: 'ws-a' })

    expect(r.session.status).toBe('active')
    expect(r.session.workspaceId).toBe('ws-a')
    expect(r.contextSources).toHaveLength(1)
    expect(r.contextSources[0].label).toBe('Context')
  })

  it('does not create any conversation on start', async () => {
    const r = await svc.startSession({ projectId: 'proj-s' })
    expect(await svc.findConversations('proj-s')).toHaveLength(0)
    expect(await svc.findConversationsByLink('session', r.session.id)).toHaveLength(0)
  })

  it('works without workspaceId', async () => {
    const r = await svc.startSession({ projectId: 'proj-s' })
    expect(r.session.workspaceId).toBeNull()
    expect(r.session.status).toBe('active')
  })
})

describe('startSession auto-recall (Phase 3 — ADR-023)', () => {
  it('returns empty recalledMemories when no memories exist', async () => {
    const task = await svc.createTask({ projectId: 'proj-s', title: 'fresh task' })
    const r = await svc.startSession({ projectId: 'proj-s', taskId: task.id, workspaceId: 'ws-a' })
    expect(r.recalledMemories).toEqual([])
  })

  it('surfaces a task-scoped memory when session binds the same taskId', async () => {
    const task = await svc.createTask({ projectId: 'proj-s', title: 'task with memory' })
    const written = await svc.writeMemory({
      scopeType: 'task',
      scopeId: task.id,
      memoryType: 'episodic',
      content: 'remember: option A beat option B',
      importance: 60
    })

    const r = await svc.startSession({ projectId: 'proj-s', taskId: task.id })
    expect(r.recalledMemories).toHaveLength(1)
    expect(r.recalledMemories[0].id).toBe(written.id)
    expect(r.recalledMemories[0].content).toBe('remember: option A beat option B')
  })

  it('merges across task/workspace/project scopes ranked by importance', async () => {
    const task = await svc.createTask({ projectId: 'proj-s', title: 'cross-scope task' })
    const mTask = await svc.writeMemory({
      scopeType: 'task',
      scopeId: task.id,
      memoryType: 'episodic',
      content: 'task-level note',
      importance: 30
    })
    const mWs = await svc.writeMemory({
      scopeType: 'workspace',
      scopeId: 'ws-a',
      memoryType: 'procedural',
      content: 'workspace-level pattern',
      importance: 80
    })
    const mProj = await svc.writeMemory({
      scopeType: 'project',
      scopeId: 'proj-s',
      memoryType: 'procedural',
      content: 'project-level convention',
      importance: 50
    })

    const r = await svc.startSession({ projectId: 'proj-s', taskId: task.id, workspaceId: 'ws-a' })
    expect(r.recalledMemories.map((m) => m.id)).toEqual([mWs.id, mProj.id, mTask.id])
  })

  it('does not surface memories from a different task', async () => {
    const taskA = await svc.createTask({ projectId: 'proj-s', title: 'task A' })
    const taskB = await svc.createTask({ projectId: 'proj-s', title: 'task B' })
    await svc.writeMemory({
      scopeType: 'task',
      scopeId: taskB.id,
      memoryType: 'episodic',
      content: 'belongs to task B',
      importance: 90
    })

    const r = await svc.startSession({ projectId: 'proj-s', taskId: taskA.id })
    expect(r.recalledMemories).toEqual([])
  })

  it('bumps recallCount on returned memories', async () => {
    const task = await svc.createTask({ projectId: 'proj-s', title: 'recall-stat task' })
    const written = await svc.writeMemory({
      scopeType: 'task',
      scopeId: task.id,
      memoryType: 'episodic',
      content: 'will be recalled',
      importance: 50
    })
    expect(written.recallCount).toBe(0)

    await svc.startSession({ projectId: 'proj-s', taskId: task.id })
    const recalled = await svc.recallMemories({ taskId: task.id })
    expect(recalled[0].recallCount).toBeGreaterThanOrEqual(1)
  })
})

describe('endSession', () => {
  it('happy path: active → completed + handoff persisted, no convs by default', async () => {
    const started = await svc.startSession({ projectId: 'proj-s' })
    const r = await svc.endSession(started.session.id, {
      handoff: { resumePoint: 'done for the day', decisions: ['chose option A'] }
    })

    expect(r.session.status).toBe('completed')
    expect(r.session.endedAt).not.toBeNull()
    expect(r.session.handoff?.resumePoint).toBe('done for the day')
    expect(r.closedConversationIds).toEqual([])
  })

  it('closes session-linked conversations opened mid-session', async () => {
    const started = await svc.startSession({ projectId: 'proj-s' })
    const conv = await svc.openConversation({
      projectId: 'proj-s',
      title: 'Mid-session discussion',
      createdBy: 'Butter',
      initialMessage: { content: 'thoughts?' }
    })

    const r = await svc.endSession(started.session.id, {
      handoff: { resumePoint: 'done for the day' }
    })

    expect(r.closedConversationIds).toEqual([conv.id])
    const after = await svc.getConversation(conv.id)
    expect(after?.status).toBe('decided')
    expect(after?.decisionSummary).toBe('done for the day')
  })

  it('marks linked task DONE when session had a taskId', async () => {
    const started = await svc.startSession({ projectId: 'proj-s' })
    const task = await svc.createTask({ projectId: 'proj-s', title: 'Do X' })
    await svc.updateSession(started.session.id, { taskId: task.id })

    const r = await svc.endSession(started.session.id, {
      handoff: { resumePoint: 'x' }
    })

    expect(r.taskUpdated).toEqual({ id: task.id, title: 'Do X', newStatus: 'DONE' })
    expect((await svc.getTask(task.id))?.status).toBe('DONE')
  })

  it('uses custom decisionSummary when provided', async () => {
    const started = await svc.startSession({ projectId: 'proj-s' })
    const conv = await svc.openConversation({
      projectId: 'proj-s',
      title: 'Mid-session discussion',
      createdBy: 'Butter',
      initialMessage: { content: 'thoughts?' }
    })
    await svc.endSession(started.session.id, {
      handoff: { resumePoint: 'r' },
      decisionSummary: 'custom summary'
    })
    expect((await svc.getConversation(conv.id))?.decisionSummary).toBe('custom summary')
  })

  it('throws SessionNotFoundError on missing id', async () => {
    await expect(svc.endSession('SESSION-999', { handoff: { resumePoint: 'x' } })).rejects.toThrow(
      SessionNotFoundError
    )
  })

  it('throws SessionStatusError when session already completed', async () => {
    const started = await svc.startSession({ projectId: 'proj-s' })
    await svc.endSession(started.session.id, { handoff: { resumePoint: 'r' } })
    await expect(svc.endSession(started.session.id, { handoff: { resumePoint: 'again' } })).rejects.toThrow(SessionStatusError)
  })
})

describe('endSession memory candidates (Phase 2 — ADR-023)', () => {
  it('returns empty array + empty prompt when session has zero candidate events', async () => {
    const started = await svc.startSession({ projectId: 'proj-s' })
    const r = await svc.endSession(started.session.id, { handoff: { resumePoint: 'r' } })
    expect(r.memoryCandidates).toEqual([])
    expect(r.selfEditPrompt).toBe('')
  })

  it('ignores non-candidate events even when present', async () => {
    const started = await svc.startSession({ projectId: 'proj-s' })
    await svc.createSessionEvent({
      sessionId: started.session.id,
      eventType: 'tool_call',
      memoryCandidate: false
    })
    await svc.createSessionEvent({
      sessionId: started.session.id,
      eventType: 'observation'
      // memoryCandidate omitted — defaults to false
    })
    const r = await svc.endSession(started.session.id, { handoff: { resumePoint: 'r' } })
    expect(r.memoryCandidates).toEqual([])
    expect(r.selfEditPrompt).toBe('')
  })

  it('returns single candidate + singular-form prompt mentioning memory_write', async () => {
    const started = await svc.startSession({ projectId: 'proj-s' })
    const evt = await svc.createSessionEvent({
      sessionId: started.session.id,
      eventType: 'decision',
      payloadJson: JSON.stringify({ text: 'picked option A' }),
      memoryCandidate: true
    })

    const r = await svc.endSession(started.session.id, { handoff: { resumePoint: 'r' } })
    expect(r.memoryCandidates).toHaveLength(1)
    expect(r.memoryCandidates[0].id).toBe(evt.id)
    expect(r.memoryCandidates[0].memoryCandidate).toBe(true)
    expect(r.selfEditPrompt).toMatch(/1 candidate event\b/)
    expect(r.selfEditPrompt).toContain('memory_write')
  })

  it('returns 3 candidates sorted oldest-first with plural prompt; excludes non-candidates', async () => {
    const started = await svc.startSession({ projectId: 'proj-s' })
    const e1 = await svc.createSessionEvent({
      sessionId: started.session.id,
      eventType: 'decision',
      memoryCandidate: true
    })
    await svc.createSessionEvent({
      sessionId: started.session.id,
      eventType: 'observation',
      memoryCandidate: false
    })
    const e2 = await svc.createSessionEvent({
      sessionId: started.session.id,
      eventType: 'observation',
      memoryCandidate: true
    })
    const e3 = await svc.createSessionEvent({
      sessionId: started.session.id,
      eventType: 'tool_call',
      memoryCandidate: true
    })

    const r = await svc.endSession(started.session.id, { handoff: { resumePoint: 'r' } })
    expect(r.memoryCandidates.map((c) => c.id)).toEqual([e1.id, e2.id, e3.id])
    expect(r.selfEditPrompt).toMatch(/3 candidate events\b/)
    expect(r.selfEditPrompt).toContain('memory_write')
    expect(r.selfEditPrompt).toContain('episodic')
    expect(r.selfEditPrompt).toContain('procedural')
  })

  it('does not surface candidates from other sessions', async () => {
    const a = await svc.startSession({ projectId: 'proj-s' })
    const b = await svc.startSession({ projectId: 'proj-s' })
    await svc.createSessionEvent({
      sessionId: b.session.id,
      eventType: 'decision',
      memoryCandidate: true
    })

    const r = await svc.endSession(a.session.id, { handoff: { resumePoint: 'r' } })
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

  it('persists one session_events observation with kind=session_summary when summary provided', async () => {
    const started = await svc.startSession({ projectId: 'proj-s' })
    const r = await svc.endSession(started.session.id, {
      handoff: { resumePoint: 'shipped' },
      summary: sampleSummary
    })

    expect(r.session.status).toBe('completed')
    const events = await svc.listSessionEvents(started.session.id, 'observation')
    expect(events).toHaveLength(1)
    const payload = JSON.parse(events[0].payloadJson ?? '{}')
    expect(payload.kind).toBe('session_summary')
    expect(payload.summary).toBe('Shipped X, queued Y.')
    expect(payload.tasksDone).toEqual(['TASK-1'])
    expect(payload.acCoverage).toEqual({ 'TASK-1': '3/3 verified (lint+vitest+build). 0 deferred.' })
    expect(events[0].memoryCandidate).toBe(false)
  })

  it('omits the observation row when summary is not provided (backward compat)', async () => {
    const started = await svc.startSession({ projectId: 'proj-s' })
    await svc.endSession(started.session.id, { handoff: { resumePoint: 'r' } })
    expect(await svc.listSessionEvents(started.session.id, 'observation')).toEqual([])
  })

  it('accepts BE extension fields (tasksShipped, branchState, …) when present', async () => {
    const started = await svc.startSession({ projectId: 'proj-s' })
    await svc.endSession(started.session.id, {
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
    const events = await svc.listSessionEvents(started.session.id, 'observation')
    const payload = JSON.parse(events[0].payloadJson ?? '{}')
    expect(payload.tasksShipped[0].tests).toBe(12)
    expect(payload.branchState).toBe('feat/x merged to main')
  })

  it('rolls back the observation row when the session close fails (atomic)', async () => {
    const started = await svc.startSession({ projectId: 'proj-s' })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lifecycle = (svc as any).sessionLifecycle
    const orig = lifecycle.sessions.update.bind(lifecycle.sessions)
    lifecycle.sessions.update = () => {
      throw new Error('simulated session update failure')
    }

    await expect(svc.endSession(started.session.id, {
        handoff: { resumePoint: 'will rollback' },
        summary: sampleSummary
      })).rejects.toThrow('simulated session update failure')

    lifecycle.sessions.update = orig

    expect((await svc.getSession(started.session.id))?.status).toBe('active')
    expect(await svc.listSessionEvents(started.session.id, 'observation')).toEqual([])
  })
})

describe('endSession aggregator (ADR-029 step 4 / TASK-913)', () => {
  const narrativeOnlySummary = {
    summary: 'narrative only',
    tasksDone: [],
    tasksCreated: [],
    tasksCancelled: [],
    commits: [],
    conversations: [],
    openItems: []
  }

  function findSummaryPayload(
    events: Array<{ payloadJson: string | null }>
  ): Record<string, unknown> {
    const evt = events.find((e) => {
      const p = JSON.parse(e.payloadJson ?? '{}') as Record<string, unknown>
      return p.kind === 'session_summary'
    })
    if (!evt) throw new Error('no session_summary event found')
    return JSON.parse(evt.payloadJson ?? '{}') as Record<string, unknown>
  }

  it('auto-fills filesChanged from kind=file_modified events when AI omits', async () => {
    const started = await svc.startSession({ projectId: 'proj-s' })
    await svc.createSessionEvent({
      sessionId: started.session.id,
      eventType: 'observation',
      payloadJson: JSON.stringify({
        kind: 'file_modified',
        path: 'src/foo.ts',
        linesAdded: 5,
        linesRemoved: 2
      }),
      memoryCandidate: false
    })

    await svc.endSession(started.session.id, {
      handoff: { resumePoint: 'r' },
      summary: narrativeOnlySummary
    })

    const events = await svc.listSessionEvents(started.session.id, 'observation')
    const payload = findSummaryPayload(events)
    expect(payload.filesChanged).toEqual(['src/foo.ts (+5, -2)'])
  })

  it('preserves AI-provided filesChanged verbatim and appends only unseen paths', async () => {
    const started = await svc.startSession({ projectId: 'proj-s' })
    await svc.createSessionEvent({
      sessionId: started.session.id,
      eventType: 'observation',
      payloadJson: JSON.stringify({
        kind: 'file_modified',
        path: 'src/x.ts',
        linesAdded: 3,
        linesRemoved: 1
      }),
      memoryCandidate: false
    })
    await svc.createSessionEvent({
      sessionId: started.session.id,
      eventType: 'observation',
      payloadJson: JSON.stringify({
        kind: 'file_modified',
        path: 'src/y.ts',
        linesAdded: 7,
        linesRemoved: 0
      }),
      memoryCandidate: false
    })

    await svc.endSession(started.session.id, {
      handoff: { resumePoint: 'r' },
      summary: { ...narrativeOnlySummary, filesChanged: ['src/x.ts (refactor)'] }
    })

    const events = await svc.listSessionEvents(started.session.id, 'observation')
    const payload = findSummaryPayload(events)
    expect(payload.filesChanged).toEqual(['src/x.ts (refactor)', 'src/y.ts (+7, -0)'])
  })

  it('derives acCoverage from kind=ac_check events with findAcItems denominator when AI omits', async () => {
    const started = await svc.startSession({ projectId: 'proj-s' })
    const task = await svc.createTask({
      projectId: 'proj-s',
      title: 'AC denominator task',
      body: '## Context\nfoo\n\n## Acceptance\n- [ ] one\n- [ ] two\n- [ ] three\n'
    })
    await svc.createSessionEvent({
      sessionId: started.session.id,
      eventType: 'observation',
      payloadJson: JSON.stringify({
        kind: 'ac_check',
        taskId: task.id,
        acIndex: 0,
        text: 'one',
        evidence: 'lint exits 0'
      }),
      memoryCandidate: false
    })

    await svc.endSession(started.session.id, {
      handoff: { resumePoint: 'r' },
      summary: narrativeOnlySummary
    })

    const events = await svc.listSessionEvents(started.session.id, 'observation')
    const payload = findSummaryPayload(events)
    expect(payload.acCoverage).toEqual({ [task.id]: '1/3 verified (lint exits 0)' })
  })

  it('appends " + K auto-detected" to AI-provided acCoverage when events also exist', async () => {
    const started = await svc.startSession({ projectId: 'proj-s' })
    const task = await svc.createTask({
      projectId: 'proj-s',
      title: 'AC suffix task',
      body: '## Acceptance\n- [ ] one\n- [ ] two\n'
    })
    await svc.createSessionEvent({
      sessionId: started.session.id,
      eventType: 'observation',
      payloadJson: JSON.stringify({
        kind: 'ac_check',
        taskId: task.id,
        acIndex: 0,
        text: 'one',
        evidence: 'vitest 1/1'
      }),
      memoryCandidate: false
    })
    await svc.createSessionEvent({
      sessionId: started.session.id,
      eventType: 'observation',
      payloadJson: JSON.stringify({
        kind: 'ac_check',
        taskId: task.id,
        acIndex: 1,
        text: 'two',
        evidence: 'build exits 0'
      }),
      memoryCandidate: false
    })

    await svc.endSession(started.session.id, {
      handoff: { resumePoint: 'r' },
      summary: {
        ...narrativeOnlySummary,
        acCoverage: { [task.id]: '2/2 verified (manual). 0 deferred.' }
      }
    })

    const events = await svc.listSessionEvents(started.session.id, 'observation')
    const payload = findSummaryPayload(events)
    expect(payload.acCoverage).toEqual({
      [task.id]: '2/2 verified (manual). 0 deferred. + 2 auto-detected'
    })
  })

  it('rolls back the session_summary row when aggregator SELECT throws mid-tx (atomic)', async () => {
    const started = await svc.startSession({ projectId: 'proj-s' })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lifecycle = (svc as any).sessionLifecycle
    const orig = lifecycle.sessionEvents.listBySession.bind(lifecycle.sessionEvents)
    lifecycle.sessionEvents.listBySession = () => {
      throw new Error('simulated aggregator SELECT failure')
    }

    await expect(svc.endSession(started.session.id, {
        handoff: { resumePoint: 'will rollback' },
        summary: narrativeOnlySummary
      })).rejects.toThrow('simulated aggregator SELECT failure')

    lifecycle.sessionEvents.listBySession = orig

    expect((await svc.getSession(started.session.id))?.status).toBe('active')
    expect(await svc.listSessionEvents(started.session.id, 'observation')).toEqual([])
  })
})

describe('abandonSession', () => {
  it('happy path: active → completed with handoff.failureReason; task stays IN-PROGRESS', async () => {
    const task = await svc.createTask({ projectId: 'proj-s', title: 'Bound task' })
    const started = await svc.startSession({ projectId: 'proj-s', taskId: task.id })

    const r = await svc.abandonSession(started.session.id, 'AC step 2 failed: lint errors')

    expect(r.session.status).toBe('completed')
    expect(r.session.endedAt).not.toBeNull()
    expect(r.session.handoff?.failureReason).toBe('AC step 2 failed: lint errors')
    // Task intentionally untouched — leaves human-review breadcrumb in IN-PROGRESS state.
    expect((await svc.getTask(task.id))?.status).toBe('IN-PROGRESS')
  })

  it('preserves prior handoff fields and adds failureReason on top', async () => {
    const started = await svc.startSession({ projectId: 'proj-s' })
    await svc.updateSession(started.session.id, {
      handoff: { resumePoint: 'mid-attempt', decisions: ['picked option A'] }
    })

    const r = await svc.abandonSession(started.session.id, 'spawn crashed')

    expect(r.session.handoff?.resumePoint).toBe('mid-attempt')
    expect(r.session.handoff?.decisions).toEqual(['picked option A'])
    expect(r.session.handoff?.failureReason).toBe('spawn crashed')
  })

  it('closes session-linked conversations with abandon-prefixed decisionSummary', async () => {
    const started = await svc.startSession({ projectId: 'proj-s' })
    const conv = await svc.openConversation({
      projectId: 'proj-s',
      title: 'Mid-session discussion',
      createdBy: 'Butter',
      initialMessage: { content: 'thoughts?' }
    })

    const r = await svc.abandonSession(started.session.id, 'cost cap exceeded')

    expect(r.closedConversationIds).toEqual([conv.id])
    const after = await svc.getConversation(conv.id)
    expect(after?.status).toBe('decided')
    expect(after?.decisionSummary).toBe('Abandoned: cost cap exceeded')
  })

  it('does not touch task when session has no taskId', async () => {
    const started = await svc.startSession({ projectId: 'proj-s' })
    await svc.abandonSession(started.session.id, 'no-task abort')
    expect((await svc.getSession(started.session.id))?.handoff?.failureReason).toBe('no-task abort')
  })

  it('throws SessionNotFoundError on missing id', async () => {
    await expect(svc.abandonSession('SESSION-999', 'r')).rejects.toThrow(SessionNotFoundError)
  })

  it('throws SessionStatusError when session already completed', async () => {
    const started = await svc.startSession({ projectId: 'proj-s' })
    await svc.endSession(started.session.id, { handoff: { resumePoint: 'r' } })
    await expect(svc.abandonSession(started.session.id, 'r')).rejects.toThrow(SessionStatusError)
  })

  it('throws SessionStatusError when session already abandoned', async () => {
    const started = await svc.startSession({ projectId: 'proj-s' })
    await svc.abandonSession(started.session.id, 'first abort')
    await expect(svc.abandonSession(started.session.id, 'second abort')).rejects.toThrow(
      SessionStatusError
    )
  })

  it('rolls back transaction on conversation close failure — task and session stay intact', async () => {
    const task = await svc.createTask({ projectId: 'proj-s', title: 'Atomic' })
    const started = await svc.startSession({ projectId: 'proj-s', taskId: task.id })
    const conv = await svc.openConversation({
      projectId: 'proj-s',
      title: 'Mid',
      createdBy: 'Butter',
      initialMessage: { content: 'q' }
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lifecycle = (svc as any).sessionLifecycle
    const orig = lifecycle.conversations.update.bind(lifecycle.conversations)
    lifecycle.conversations.update = () => {
      throw new Error('simulated conv update failure')
    }

    await expect(svc.abandonSession(started.session.id, 'will rollback')).rejects.toThrow(
      'simulated conv update failure'
    )

    lifecycle.conversations.update = orig

    expect((await svc.getSession(started.session.id))?.status).toBe('active')
    expect((await svc.getConversation(conv.id))?.status).toBe('open')
    expect((await svc.getTask(task.id))?.status).toBe('IN-PROGRESS')
  })
})

describe('startSession taskId binding', () => {
  it('links task to session and sets it to IN-PROGRESS', async () => {
    const task = await svc.createTask({ projectId: 'proj-s', title: 'Bound task' })
    const r = await svc.startSession({ projectId: 'proj-s', taskId: task.id })

    expect(r.session.taskId).toBe(task.id)
    expect((await svc.getTask(task.id))?.status).toBe('IN-PROGRESS')
  })

  it('throws TaskNotFoundError when taskId does not exist', async () => {
    await expect(svc.startSession({ projectId: 'proj-s', taskId: 'TASK-NOPE' })).rejects.toThrow(TaskNotFoundError)
  })

  it('throws TaskStatusError when task is already DONE', async () => {
    const task = await svc.createTask({ projectId: 'proj-s', title: 'Finished' })
    await svc.updateTask(task.id, { status: 'DONE' })

    await expect(svc.startSession({ projectId: 'proj-s', taskId: task.id })).rejects.toThrow(
      TaskStatusError
    )
  })

  it('throws TaskLockedBySessionError when task is bound to another active session', async () => {
    const task = await svc.createTask({ projectId: 'proj-s', title: 'Shared' })
    await svc.startSession({ projectId: 'proj-s', taskId: task.id })

    await expect(svc.startSession({ projectId: 'proj-s', taskId: task.id })).rejects.toThrow(
      TaskLockedBySessionError
    )
  })

  it('allows re-binding after the prior session ends', async () => {
    const task = await svc.createTask({ projectId: 'proj-s', title: 'Handoff' })
    const first = await svc.startSession({ projectId: 'proj-s', taskId: task.id })
    await svc.endSession(first.session.id, { handoff: { resumePoint: 'paused' } })
    // endSession marked it DONE — reopen before re-binding
    await svc.updateTask(task.id, { status: 'READY' })

    const second = await svc.startSession({ projectId: 'proj-s', taskId: task.id })
    expect(second.session.taskId).toBe(task.id)
  })

  it('rolls back task status on transaction failure', async () => {
    const task = await svc.createTask({ projectId: 'proj-s', title: 'Rollback' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lifecycle = (svc as any).sessionLifecycle
    const orig = lifecycle.contextSources.findByProject.bind(lifecycle.contextSources)
    lifecycle.contextSources.findByProject = () => {
      throw new Error('simulated context lookup failure')
    }

    await expect(svc.startSession({ projectId: 'proj-s', taskId: task.id })).rejects.toThrow(
      'simulated context lookup failure'
    )

    lifecycle.contextSources.findByProject = orig

    expect((await svc.getTask(task.id))?.status).not.toBe('IN-PROGRESS')
    expect(await svc.findSessions('proj-s')).toHaveLength(0)
  })
})

describe('startSession existingActiveSessions', () => {
  it('returns empty array when no prior active sessions', async () => {
    const r = await svc.startSession({ projectId: 'proj-s' })
    expect(r.existingActiveSessions).toEqual([])
  })

  it('surfaces prior active sessions without blocking new session creation', async () => {
    const first = await svc.startSession({ projectId: 'proj-s', workspaceId: 'ws-a' })
    const second = await svc.startSession({ projectId: 'proj-s', workspaceId: 'ws-b' })

    expect(second.session.id).not.toBe(first.session.id)
    expect(second.existingActiveSessions).toHaveLength(1)
    expect(second.existingActiveSessions[0].id).toBe(first.session.id)
  })

  it('excludes completed sessions from existingActiveSessions', async () => {
    const first = await svc.startSession({ projectId: 'proj-s' })
    await svc.endSession(first.session.id, { handoff: { resumePoint: 'r' } })

    const second = await svc.startSession({ projectId: 'proj-s' })
    expect(second.existingActiveSessions).toEqual([])
  })
})

describe('checkpointSession', () => {
  it('happy path: sets checkpoint + checkpointAt, session stays active', async () => {
    const started = await svc.startSession({ projectId: 'proj-s' })
    const r = await svc.checkpointSession(started.session.id, {
      checkpoint: { resumePoint: 'mid-refactor', dirtyFiles: ['src/a.ts'] }
    })

    expect(r.session.status).toBe('active')
    expect(r.session.checkpoint?.resumePoint).toBe('mid-refactor')
    expect(r.session.checkpoint?.dirtyFiles).toEqual(['src/a.ts'])
    expect(r.session.checkpointAt).not.toBeNull()
  })

  it('overwrite on second call, checkpointAt bumps', async () => {
    const started = await svc.startSession({ projectId: 'proj-s' })
    const r1 = await svc.checkpointSession(started.session.id, {
      checkpoint: { resumePoint: 'first', notes: 'n1' }
    })
    // tick so the timestamp second differs — SQLite datetime('now') has second granularity
    await new Promise((resolve) => setTimeout(resolve, 1100))
    const r2 = await svc.checkpointSession(started.session.id, {
      checkpoint: { resumePoint: 'second' }
    })

    expect(r2.session.checkpoint?.resumePoint).toBe('second')
    expect(r2.session.checkpoint?.notes).toBeUndefined()
    expect(r2.session.checkpointAt).not.toBe(r1.session.checkpointAt)
  })

  it('throws SessionNotFoundError on missing id', async () => {
    await expect(svc.checkpointSession('SESSION-999', { checkpoint: { resumePoint: 'r' } })).rejects.toThrow(SessionNotFoundError)
  })

  it('throws SessionStatusError on completed session', async () => {
    const started = await svc.startSession({ projectId: 'proj-s' })
    await svc.endSession(started.session.id, { handoff: { resumePoint: 'r' } })
    await expect(svc.checkpointSession(started.session.id, { checkpoint: { resumePoint: 'r' } })).rejects.toThrow(SessionStatusError)
  })
})

describe('resumeSession', () => {
  it('returns session + null checkpoint + linked conversations + context sources', async () => {
    await svc.createContextSource({
      projectId: 'proj-s',
      sourceType: 'file',
      sourcePath: 'docs/ctx.md',
      label: 'Ctx',
      category: 'what'
    })
    const started = await svc.startSession({ projectId: 'proj-s' })
    const conv = await svc.openConversation({
      projectId: 'proj-s',
      title: 'Mid-session discussion',
      createdBy: 'Butter',
      initialMessage: { content: 'thoughts?' }
    })

    const r = await svc.resumeSession(started.session.id)
    expect(r.session.id).toBe(started.session.id)
    expect(r.checkpoint).toBeNull()
    expect(r.conversations.map((c) => c.id)).toEqual([conv.id])
    expect(r.contextSources.map((c) => c.label)).toEqual(['Ctx'])
  })

  it('returns checkpoint when one exists', async () => {
    const started = await svc.startSession({ projectId: 'proj-s' })
    await svc.checkpointSession(started.session.id, {
      checkpoint: { resumePoint: 'pause', lastCommit: 'abc123' }
    })

    const r = await svc.resumeSession(started.session.id)
    expect(r.checkpoint?.resumePoint).toBe('pause')
    expect(r.checkpoint?.lastCommit).toBe('abc123')
  })

  it('works on completed sessions (read-only replay)', async () => {
    const started = await svc.startSession({ projectId: 'proj-s' })
    await svc.endSession(started.session.id, { handoff: { resumePoint: 'r' } })

    const r = await svc.resumeSession(started.session.id)
    expect(r.session.status).toBe('completed')
  })

  it('throws SessionNotFoundError on missing id', async () => {
    await expect(svc.resumeSession('SESSION-999')).rejects.toThrow(SessionNotFoundError)
  })
})

describe('transaction rollback (atomicity)', () => {
  it('rolls back session creation when context-source lookup fails mid-start', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lifecycle = (svc as any).sessionLifecycle
    const orig = lifecycle.contextSources.findByProject.bind(lifecycle.contextSources)
    lifecycle.contextSources.findByProject = () => {
      throw new Error('simulated context lookup failure')
    }

    await expect(svc.startSession({ projectId: 'proj-s' })).rejects.toThrow(
      'simulated context lookup failure'
    )

    lifecycle.contextSources.findByProject = orig

    expect(await svc.findSessions('proj-s')).toHaveLength(0)
  })

  it('rolls back session status + conv close when task update fails mid-end', async () => {
    const started = await svc.startSession({ projectId: 'proj-s' })
    const conv = await svc.openConversation({
      projectId: 'proj-s',
      title: 'Mid-session discussion',
      createdBy: 'Butter',
      initialMessage: { content: 'thoughts?' }
    })
    const task = await svc.createTask({ projectId: 'proj-s', title: 'Y' })
    await svc.updateSession(started.session.id, { taskId: task.id })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lifecycle = (svc as any).sessionLifecycle
    const orig = lifecycle.tasks.update.bind(lifecycle.tasks)
    lifecycle.tasks.update = () => {
      throw new Error('simulated task failure')
    }

    await expect(svc.endSession(started.session.id, { handoff: { resumePoint: 'x' } })).rejects.toThrow(
      'simulated task failure'
    )

    lifecycle.tasks.update = orig

    expect((await svc.getSession(started.session.id))?.status).toBe('active')
    expect((await svc.getConversation(conv.id))?.status).toBe('open')
    expect((await svc.getTask(task.id))?.status).not.toBe('DONE')
  })
})

describe('endSession gotcha-auto drafts (TASK-998)', () => {
  // Parse the gotcha_draft payloads out of the returned memory candidates.
  function gotchaDrafts(candidates: Array<{ payloadJson: string | null }>): Array<Record<string, unknown>> {
    return candidates
      .map((c) => JSON.parse(c.payloadJson ?? '{}') as Record<string, unknown>)
      .filter((p) => p.kind === 'gotcha_draft')
  }

  it('drafts one candidate gotcha per handoff decision, surfaced as memory candidates', async () => {
    const task = await svc.createTask({ projectId: 'proj-s', title: 'realize work' })
    const started = await svc.startSession({ projectId: 'proj-s', taskId: task.id })

    const r = await svc.endSession(started.session.id, {
      handoff: { resumePoint: 'done', decisions: ['chose option A', 'cache TTL is 5m because of WAL'] }
    })

    const drafts = gotchaDrafts(r.memoryCandidates)
    expect(drafts).toHaveLength(2)
    expect(r.memoryCandidates.every((c) => c.memoryCandidate)).toBe(true)
    expect(r.selfEditPrompt).toContain('gotcha draft')
    expect(r.selfEditPrompt).toContain("knowledge_create(type='gotcha')")
  })

  it('infers affectedFeatureId from the task REALIZES edge', async () => {
    const task = await svc.createTask({ projectId: 'proj-s', title: 'feature work' })
    await svc.addRelationship(task.id, 'feature-x', 'REALIZES')
    const started = await svc.startSession({ projectId: 'proj-s', taskId: task.id })

    const r = await svc.endSession(started.session.id, {
      handoff: { resumePoint: 'done', decisions: ['store logo via FE static map'] }
    })

    const [draft] = gotchaDrafts(r.memoryCandidates)
    expect(draft.affectedFeatureId).toBe('feature-x')
    expect(draft.needsFeature).toBe(false)
  })

  it('flags needsFeature when the task has no REALIZES edge', async () => {
    const task = await svc.createTask({ projectId: 'proj-s', title: 'edgeless work' })
    const started = await svc.startSession({ projectId: 'proj-s', taskId: task.id })

    const r = await svc.endSession(started.session.id, {
      handoff: { resumePoint: 'done', decisions: ['some decision'] }
    })

    const [draft] = gotchaDrafts(r.memoryCandidates)
    expect(draft.affectedFeatureId).toBeNull()
    expect(draft.needsFeature).toBe(true)
    expect(r.selfEditPrompt).toContain('ask the human which feature')
  })

  it('emits no gotcha drafts when the handoff has no decisions', async () => {
    const task = await svc.createTask({ projectId: 'proj-s', title: 'no decisions' })
    const started = await svc.startSession({ projectId: 'proj-s', taskId: task.id })

    const r = await svc.endSession(started.session.id, { handoff: { resumePoint: 'done' } })
    expect(gotchaDrafts(r.memoryCandidates)).toHaveLength(0)
  })

  it('does NOT persist a real gotcha — drafts are human-gated', async () => {
    const task = await svc.createTask({ projectId: 'proj-s', title: 'gated' })
    await svc.addRelationship(task.id, 'feature-x', 'REALIZES')
    const started = await svc.startSession({ projectId: 'proj-s', taskId: task.id })

    await svc.endSession(started.session.id, {
      handoff: { resumePoint: 'done', decisions: ['a decision worth a gotcha'] }
    })

    expect(await svc.listKnowledge({ projectId: 'proj-s', type: 'gotcha' })).toEqual([])
  })
})

describe('draftGotchaFromDecision (TASK-998 unit)', () => {
  it('splits rule vs resolution on a rationale marker and carries raw text', () => {
    const d = draftGotchaFromDecision('use FE static map because BE iconUrl is unreliable', 'feature-x')
    expect(d.businessRule).toBe('use FE static map')
    expect(d.resolution).toBe('BE iconUrl is unreliable')
    expect(d.affectedFeatureId).toBe('feature-x')
    expect(d.needsFeature).toBe(false)
    expect(d.sourceDecision).toBe('use FE static map because BE iconUrl is unreliable')
  })

  it('keeps the whole text as businessRule when there is no marker, and flags needsFeature on null', () => {
    const d = draftGotchaFromDecision('a flat statement', null)
    expect(d.businessRule).toBe('a flat statement')
    expect(d.resolution).toBe('')
    expect(d.needsFeature).toBe(true)
  })

  it('does NOT split on an in-word hyphen — splits on the rationale word instead', () => {
    const d = draftGotchaFromDecision(
      'Source logo source-of-truth is the FE static map, not BE iconUrl, because coverage is unreliable',
      'feature-x'
    )
    expect(d.businessRule).toBe('Source logo source-of-truth is the FE static map, not BE iconUrl')
    expect(d.resolution).toBe('coverage is unreliable')
  })

  it('splits on a space-flanked hyphen but not a bare/in-word one', () => {
    const d = draftGotchaFromDecision('cap page-size at 10 - clamp server-side', null)
    expect(d.businessRule).toBe('cap page-size at 10')
    expect(d.resolution).toBe('clamp server-side')
  })
})
