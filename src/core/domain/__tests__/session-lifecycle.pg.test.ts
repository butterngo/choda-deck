// Sibling of lifecycle/session-lifecycle-service.test.ts — drives the 5
// session composite ops through PostgresTaskService.
//
// Trims vs the sqlite suite (~60 tests):
//   - Rollback monkey-patch tests don't port (tx-bound repos are constructed
//     inside `conn.transaction(async tx => …)` each call — no externally
//     reachable handle to stub). Atomicity covered by other .pg.test.ts
//     suites (e.g. tasks-slice).
//   - BE-extension structural fields test trimmed (not pg-specific).
//   - "works without workspaceId" / "does not create conversation on start"
//     collapsed into one happy path.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  describeIfDocker,
  startPostgresTestEnv,
  stopPostgresTestEnv,
  type PgTestEnv
} from '../../../test/postgres-harness'
import { PostgresTaskService } from '../postgres-task-service'
import {
  SessionNotFoundError,
  SessionStatusError,
  TaskLockedBySessionError,
  TaskNotFoundError,
  TaskStatusError
} from '../lifecycle/errors'

describeIfDocker('PostgresTaskService session lifecycle', () => {
  let env: PgTestEnv
  let svc: PostgresTaskService

  beforeAll(async () => {
    env = await startPostgresTestEnv()
    svc = new PostgresTaskService(env.conn)
    await svc.initializeAsync()
  }, 120_000)

  afterAll(async () => {
    if (env) await stopPostgresTestEnv(env)
  }, 30_000)

  beforeEach(async () => {
    await env.conn.query('DELETE FROM agent_memories')
    await env.conn.query('DELETE FROM session_events')
    await env.conn.query('DELETE FROM conversation_actions')
    await env.conn.query('DELETE FROM conversation_messages')
    await env.conn.query('DELETE FROM conversation_links')
    await env.conn.query('DELETE FROM conversation_participants')
    await env.conn.query('DELETE FROM conversations')
    await env.conn.query('DELETE FROM context_sources')
    await env.conn.query('DELETE FROM relationships')
    await env.conn.query('DELETE FROM tags')
    await env.conn.query('DELETE FROM tasks')
    await env.conn.query('DELETE FROM sessions')
    await env.conn.query('DELETE FROM workspaces')
    await env.conn.query('DELETE FROM projects')
    await env.conn.query(
      "UPDATE global_counters SET last_number = 0 WHERE entity_type IN ('task','session','conv','act','evt','mem')"
    )
    await svc.ensureProject('proj-s', 'Session Project', '/tmp/s')
  })

  // ── startSession ─────────────────────────────────────────────────────────
  describe('startSession', () => {
    it('happy path: creates session + returns ONLY active context sources, no auto conv', async () => {
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
      expect(await svc.findConversations('proj-s')).toHaveLength(0)
    })

    it('works without workspaceId', async () => {
      const r = await svc.startSession({ projectId: 'proj-s' })
      expect(r.session.workspaceId).toBeNull()
      expect(r.session.status).toBe('active')
    })
  })

  // ── startSession auto-recall ─────────────────────────────────────────────
  describe('startSession auto-recall (ADR-023 Phase 3)', () => {
    it('returns empty recalledMemories when no memories exist', async () => {
      const task = await svc.createTask({ projectId: 'proj-s', title: 'fresh task' })
      const r = await svc.startSession({ projectId: 'proj-s', taskId: task.id })
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
    })

    it('does not surface memories from a different task', async () => {
      const taskA = await svc.createTask({ projectId: 'proj-s', title: 'A' })
      const taskB = await svc.createTask({ projectId: 'proj-s', title: 'B' })
      await svc.writeMemory({
        scopeType: 'task',
        scopeId: taskA.id,
        memoryType: 'episodic',
        content: 'A-only',
        importance: 80
      })
      const r = await svc.startSession({ projectId: 'proj-s', taskId: taskB.id })
      expect(r.recalledMemories).toEqual([])
    })
  })

  // ── startSession taskId binding ──────────────────────────────────────────
  describe('startSession taskId binding', () => {
    it('links task to session and sets it to IN-PROGRESS', async () => {
      const task = await svc.createTask({ projectId: 'proj-s', title: 'bind task' })
      const r = await svc.startSession({ projectId: 'proj-s', taskId: task.id })
      expect(r.session.taskId).toBe(task.id)
      const updated = await svc.getTask(task.id)
      expect(updated?.status).toBe('IN-PROGRESS')
    })

    it('throws TaskNotFoundError when taskId does not exist', async () => {
      await expect(
        svc.startSession({ projectId: 'proj-s', taskId: 'TASK-999' })
      ).rejects.toThrow(TaskNotFoundError)
    })

    it('throws TaskStatusError when task is already DONE', async () => {
      const task = await svc.createTask({ projectId: 'proj-s', title: 'done task' })
      await svc.updateTask(task.id, { status: 'DONE' })
      await expect(
        svc.startSession({ projectId: 'proj-s', taskId: task.id })
      ).rejects.toThrow(TaskStatusError)
    })

    it('throws TaskLockedBySessionError when task is bound to another active session', async () => {
      const task = await svc.createTask({ projectId: 'proj-s', title: 'locked' })
      await svc.startSession({ projectId: 'proj-s', taskId: task.id })
      await expect(
        svc.startSession({ projectId: 'proj-s', taskId: task.id })
      ).rejects.toThrow(TaskLockedBySessionError)
    })

    it('allows re-binding after the prior session ends', async () => {
      const task = await svc.createTask({ projectId: 'proj-s', title: 'rebind' })
      const first = await svc.startSession({ projectId: 'proj-s', taskId: task.id })
      await svc.endSession(first.session.id, {
        handoff: { commits: [], decisions: [], resumePoint: '' }
      })
      // After end, task is DONE — can't restart, so put it back to TODO first.
      await svc.updateTask(task.id, { status: 'TODO' })
      const second = await svc.startSession({ projectId: 'proj-s', taskId: task.id })
      expect(second.session.id).not.toBe(first.session.id)
    })
  })

  // ── startSession existingActiveSessions ──────────────────────────────────
  describe('startSession existingActiveSessions', () => {
    it('returns empty array when no prior active sessions', async () => {
      const r = await svc.startSession({ projectId: 'proj-s' })
      expect(r.existingActiveSessions).toEqual([])
    })

    it('surfaces prior active sessions without blocking', async () => {
      const first = await svc.startSession({ projectId: 'proj-s', workspaceId: 'ws-1' })
      const second = await svc.startSession({ projectId: 'proj-s', workspaceId: 'ws-2' })
      expect(second.existingActiveSessions.map((s) => s.id)).toContain(first.session.id)
    })

    it('excludes completed sessions from existingActiveSessions', async () => {
      const first = await svc.startSession({ projectId: 'proj-s' })
      await svc.endSession(first.session.id, {
        handoff: { commits: [], decisions: [], resumePoint: '' }
      })
      const second = await svc.startSession({ projectId: 'proj-s' })
      expect(second.existingActiveSessions).toEqual([])
    })
  })

  // ── endSession ───────────────────────────────────────────────────────────
  describe('endSession', () => {
    it('happy path: active → completed + handoff persisted', async () => {
      const start = await svc.startSession({ projectId: 'proj-s' })
      const r = await svc.endSession(start.session.id, {
        handoff: { commits: ['abc'], decisions: [], resumePoint: 'done' }
      })
      expect(r.session.status).toBe('completed')
      expect(r.session.handoff?.commits).toEqual(['abc'])
      expect(r.closedConversationIds).toEqual([])
      expect(r.taskUpdated).toBeNull()
    })

    it('closes session-linked conversations opened mid-session', async () => {
      const start = await svc.startSession({ projectId: 'proj-s' })
      const conv = await svc.openConversation({
        projectId: 'proj-s',
        title: 'mid-session',
        createdBy: 'Butter',
        participants: [{ name: 'Butter', type: 'human' }],
        initialMessage: { content: 'hi', type: 'question' }
      })
      const r = await svc.endSession(start.session.id, {
        handoff: { commits: [], decisions: [], resumePoint: 'done' }
      })
      expect(r.closedConversationIds).toContain(conv.id)
      const closed = await svc.getConversation(conv.id)
      expect(closed?.status).toBe('closed')
    })

    it('marks linked task DONE when session had a taskId', async () => {
      const task = await svc.createTask({ projectId: 'proj-s', title: 'taskend' })
      const start = await svc.startSession({ projectId: 'proj-s', taskId: task.id })
      const r = await svc.endSession(start.session.id, {
        handoff: { commits: [], decisions: [], resumePoint: '' }
      })
      expect(r.taskUpdated).toEqual({ id: task.id, title: 'taskend', newStatus: 'DONE' })
      expect((await svc.getTask(task.id))?.status).toBe('DONE')
    })

    it('uses custom decisionSummary when provided', async () => {
      const start = await svc.startSession({ projectId: 'proj-s' })
      const conv = await svc.openConversation({
        projectId: 'proj-s',
        title: 'conv',
        createdBy: 'Butter',
        participants: [{ name: 'Butter', type: 'human' }],
        initialMessage: { content: 'q', type: 'question' }
      })
      await svc.endSession(start.session.id, {
        handoff: { commits: [], decisions: [], resumePoint: '' },
        decisionSummary: 'custom-summary'
      })
      const closed = await svc.getConversation(conv.id)
      expect(closed?.decisionSummary).toBe('custom-summary')
    })

    it('throws SessionNotFoundError on missing id', async () => {
      await expect(
        svc.endSession('SESSION-999', {
          handoff: { commits: [], decisions: [], resumePoint: '' }
        })
      ).rejects.toThrow(SessionNotFoundError)
    })

    it('throws SessionStatusError when session already completed', async () => {
      const start = await svc.startSession({ projectId: 'proj-s' })
      await svc.endSession(start.session.id, {
        handoff: { commits: [], decisions: [], resumePoint: '' }
      })
      await expect(
        svc.endSession(start.session.id, {
          handoff: { commits: [], decisions: [], resumePoint: '' }
        })
      ).rejects.toThrow(SessionStatusError)
    })
  })

  // ── endSession memory candidates (ADR-023 Phase 2) ───────────────────────
  describe('endSession memory candidates', () => {
    it('returns empty array + empty prompt when no candidate events', async () => {
      const start = await svc.startSession({ projectId: 'proj-s' })
      const r = await svc.endSession(start.session.id, {
        handoff: { commits: [], decisions: [], resumePoint: '' }
      })
      expect(r.memoryCandidates).toEqual([])
      expect(r.selfEditPrompt).toBe('')
    })

    it('returns single candidate with singular-form prompt mentioning memory_write', async () => {
      const start = await svc.startSession({ projectId: 'proj-s' })
      await svc.createSessionEvent({
        sessionId: start.session.id,
        eventType: 'observation',
        payloadJson: JSON.stringify({ kind: 'note', content: 'remember this' }),
        memoryCandidate: true
      })
      const r = await svc.endSession(start.session.id, {
        handoff: { commits: [], decisions: [], resumePoint: '' }
      })
      expect(r.memoryCandidates).toHaveLength(1)
      expect(r.selfEditPrompt).toMatch(/1 candidate event/)
      expect(r.selfEditPrompt).toMatch(/memory_write/)
    })

    it('returns multiple candidates with plural prompt; ignores non-candidates', async () => {
      const start = await svc.startSession({ projectId: 'proj-s' })
      await svc.createSessionEvent({
        sessionId: start.session.id,
        eventType: 'observation',
        payloadJson: JSON.stringify({ kind: 'a' }),
        memoryCandidate: true
      })
      await svc.createSessionEvent({
        sessionId: start.session.id,
        eventType: 'observation',
        payloadJson: JSON.stringify({ kind: 'b' }),
        memoryCandidate: false // ignored
      })
      await svc.createSessionEvent({
        sessionId: start.session.id,
        eventType: 'observation',
        payloadJson: JSON.stringify({ kind: 'c' }),
        memoryCandidate: true
      })
      const r = await svc.endSession(start.session.id, {
        handoff: { commits: [], decisions: [], resumePoint: '' }
      })
      expect(r.memoryCandidates).toHaveLength(2)
      expect(r.selfEditPrompt).toMatch(/2 candidate events/)
    })
  })

  // ── endSession structured summary + aggregator (ADR-028 + ADR-029) ───────
  describe('endSession structured summary + aggregator', () => {
    it('persists one session_events observation row when summary provided', async () => {
      const start = await svc.startSession({ projectId: 'proj-s' })
      await svc.endSession(start.session.id, {
        handoff: { commits: [], decisions: [], resumePoint: '' },
        summary: {
          summary: 'Did the thing',
          tasksDone: [],
          tasksCreated: [],
          tasksCancelled: [],
          commits: [],
          conversations: [],
          openItems: []
        }
      })
      const events = await svc.listSessionEvents(start.session.id, 'observation')
      const summaryEvents = events.filter((e) => {
        const p = JSON.parse(e.payloadJson ?? '{}')
        return p.kind === 'session_summary'
      })
      expect(summaryEvents).toHaveLength(1)
    })

    it('omits the observation row when summary is not provided (backward compat)', async () => {
      const start = await svc.startSession({ projectId: 'proj-s' })
      await svc.endSession(start.session.id, {
        handoff: { commits: [], decisions: [], resumePoint: '' }
      })
      const events = await svc.listSessionEvents(start.session.id, 'observation')
      expect(events).toHaveLength(0)
    })

    it('auto-fills filesChanged from kind=file_modified events when AI omits', async () => {
      const start = await svc.startSession({ projectId: 'proj-s' })
      await svc.createSessionEvent({
        sessionId: start.session.id,
        eventType: 'observation',
        payloadJson: JSON.stringify({
          kind: 'file_modified',
          path: 'src/foo.ts',
          linesAdded: 10,
          linesRemoved: 3
        }),
        memoryCandidate: false
      })
      await svc.endSession(start.session.id, {
        handoff: { commits: [], decisions: [], resumePoint: '' },
        summary: {
          summary: 'work',
          tasksDone: [],
          tasksCreated: [],
          tasksCancelled: [],
          commits: [],
          conversations: [],
          openItems: []
        }
      })
      const events = await svc.listSessionEvents(start.session.id, 'observation')
      const row = events.find((e) => JSON.parse(e.payloadJson ?? '{}').kind === 'session_summary')
      const payload = JSON.parse(row!.payloadJson!)
      expect(payload.filesChanged).toContain('src/foo.ts (+10, -3)')
    })

    it('derives acCoverage from kind=ac_check events when AI omits', async () => {
      const task = await svc.createTask({
        projectId: 'proj-s',
        title: 'AC task',
        body: '## Acceptance\n- [ ] one\n- [ ] two\n'
      })
      const start = await svc.startSession({ projectId: 'proj-s', taskId: task.id })
      await svc.createSessionEvent({
        sessionId: start.session.id,
        eventType: 'observation',
        payloadJson: JSON.stringify({
          kind: 'ac_check',
          taskId: task.id,
          evidence: 'tested'
        }),
        memoryCandidate: false
      })
      // endSession marks task DONE — need to unbind first to avoid the DONE
      // status before our query reads it back. Simplest: end with summary.
      await svc.endSession(start.session.id, {
        handoff: { commits: [], decisions: [], resumePoint: '' },
        summary: {
          summary: 'work',
          tasksDone: [],
          tasksCreated: [],
          tasksCancelled: [],
          commits: [],
          conversations: [],
          openItems: []
        }
      })
      const events = await svc.listSessionEvents(start.session.id, 'observation')
      const row = events.find((e) => JSON.parse(e.payloadJson ?? '{}').kind === 'session_summary')
      const payload = JSON.parse(row!.payloadJson!)
      expect(payload.acCoverage[task.id]).toMatch(/1\/2 verified/)
    })

    it('appends " + K auto-detected" when AI provides acCoverage and events also exist', async () => {
      const task = await svc.createTask({
        projectId: 'proj-s',
        title: 'AC task',
        body: '## Acceptance\n- [ ] one\n- [ ] two\n'
      })
      const start = await svc.startSession({ projectId: 'proj-s', taskId: task.id })
      await svc.createSessionEvent({
        sessionId: start.session.id,
        eventType: 'observation',
        payloadJson: JSON.stringify({
          kind: 'ac_check',
          taskId: task.id,
          evidence: 'tested'
        }),
        memoryCandidate: false
      })
      await svc.endSession(start.session.id, {
        handoff: { commits: [], decisions: [], resumePoint: '' },
        summary: {
          summary: 'work',
          tasksDone: [],
          tasksCreated: [],
          tasksCancelled: [],
          commits: [],
          conversations: [],
          openItems: [],
          acCoverage: { [task.id]: 'AI claim' }
        }
      })
      const events = await svc.listSessionEvents(start.session.id, 'observation')
      const row = events.find((e) => JSON.parse(e.payloadJson ?? '{}').kind === 'session_summary')
      const payload = JSON.parse(row!.payloadJson!)
      expect(payload.acCoverage[task.id]).toBe('AI claim + 1 auto-detected')
    })
  })

  // ── abandonSession ──────────────────────────────────────────────────────
  describe('abandonSession', () => {
    it('happy path: active → completed with failureReason; task stays IN-PROGRESS', async () => {
      const task = await svc.createTask({ projectId: 'proj-s', title: 'failing task' })
      const start = await svc.startSession({ projectId: 'proj-s', taskId: task.id })
      const r = await svc.abandonSession(start.session.id, 'crashed')
      expect(r.session.status).toBe('completed')
      expect(r.session.handoff?.failureReason).toBe('crashed')
      expect((await svc.getTask(task.id))?.status).toBe('IN-PROGRESS')
    })

    it('closes session-linked conversations with Abandoned-prefixed summary', async () => {
      const start = await svc.startSession({ projectId: 'proj-s' })
      const conv = await svc.openConversation({
        projectId: 'proj-s',
        title: 'conv',
        createdBy: 'Butter',
        participants: [{ name: 'Butter', type: 'human' }],
        initialMessage: { content: 'q', type: 'question' }
      })
      const r = await svc.abandonSession(start.session.id, 'OOM')
      expect(r.closedConversationIds).toContain(conv.id)
      const closed = await svc.getConversation(conv.id)
      expect(closed?.decisionSummary).toBe('Abandoned: OOM')
    })

    it('does not touch task when session has no taskId', async () => {
      const start = await svc.startSession({ projectId: 'proj-s' })
      const r = await svc.abandonSession(start.session.id, 'reason')
      expect(r.session.status).toBe('completed')
    })

    it('throws SessionNotFoundError on missing id', async () => {
      await expect(svc.abandonSession('SESSION-999', 'r')).rejects.toThrow(SessionNotFoundError)
    })

    it('throws SessionStatusError when session already completed', async () => {
      const start = await svc.startSession({ projectId: 'proj-s' })
      await svc.endSession(start.session.id, {
        handoff: { commits: [], decisions: [], resumePoint: '' }
      })
      await expect(svc.abandonSession(start.session.id, 'r')).rejects.toThrow(SessionStatusError)
    })
  })

  // ── checkpointSession ───────────────────────────────────────────────────
  describe('checkpointSession', () => {
    it('sets checkpoint + checkpointAt, session stays active', async () => {
      const start = await svc.startSession({ projectId: 'proj-s' })
      const r = await svc.checkpointSession(start.session.id, {
        checkpoint: { resumePoint: 'cp-1', notes: 'mid-work' }
      })
      expect(r.session.status).toBe('active')
      expect(r.session.checkpoint?.resumePoint).toBe('cp-1')
      expect(r.session.checkpointAt).not.toBeNull()
    })

    it('overwrites checkpoint on second call', async () => {
      const start = await svc.startSession({ projectId: 'proj-s' })
      await svc.checkpointSession(start.session.id, {
        checkpoint: { resumePoint: 'cp-1' }
      })
      const r = await svc.checkpointSession(start.session.id, {
        checkpoint: { resumePoint: 'cp-2' }
      })
      expect(r.session.checkpoint?.resumePoint).toBe('cp-2')
    })

    it('throws SessionNotFoundError on missing id', async () => {
      await expect(
        svc.checkpointSession('SESSION-999', { checkpoint: { resumePoint: 'x' } })
      ).rejects.toThrow(SessionNotFoundError)
    })

    it('throws SessionStatusError when session is completed', async () => {
      const start = await svc.startSession({ projectId: 'proj-s' })
      await svc.endSession(start.session.id, {
        handoff: { commits: [], decisions: [], resumePoint: '' }
      })
      await expect(
        svc.checkpointSession(start.session.id, { checkpoint: { resumePoint: 'x' } })
      ).rejects.toThrow(SessionStatusError)
    })
  })

  // ── resumeSession ───────────────────────────────────────────────────────
  describe('resumeSession', () => {
    it('returns session + null checkpoint + linked convs + context sources', async () => {
      await svc.createContextSource({
        projectId: 'proj-s',
        sourceType: 'file',
        sourcePath: 'docs/c.md',
        label: 'ctx',
        category: 'what'
      })
      const start = await svc.startSession({ projectId: 'proj-s' })
      const r = await svc.resumeSession(start.session.id)
      expect(r.session.id).toBe(start.session.id)
      expect(r.checkpoint).toBeNull()
      expect(r.contextSources).toHaveLength(1)
      expect(r.conversations).toEqual([])
    })

    it('returns checkpoint when one exists', async () => {
      const start = await svc.startSession({ projectId: 'proj-s' })
      await svc.checkpointSession(start.session.id, {
        checkpoint: { resumePoint: 'cp', notes: 'n' }
      })
      const r = await svc.resumeSession(start.session.id)
      expect(r.checkpoint?.resumePoint).toBe('cp')
    })

    it('works on completed sessions (read-only replay)', async () => {
      const start = await svc.startSession({ projectId: 'proj-s' })
      await svc.endSession(start.session.id, {
        handoff: { commits: [], decisions: [], resumePoint: 'end' }
      })
      const r = await svc.resumeSession(start.session.id)
      expect(r.session.status).toBe('completed')
    })

    it('throws SessionNotFoundError on missing id', async () => {
      await expect(svc.resumeSession('SESSION-999')).rejects.toThrow(SessionNotFoundError)
    })
  })
})
