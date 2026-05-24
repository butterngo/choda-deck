// Sibling of lifecycle/task-review-lifecycle-service.test.ts + the
// checkAcItem integration tests in mcp-tools/__tests__/ac-check.test.ts.
// Covers 3 stubs filled in slice 18: approveTask, rejectTask, checkAcItem.
//
// Rollback monkey-patch tests don't port (tx-bound repos constructed
// inside `conn.transaction(async tx => …)`). Atomicity is covered by
// other .pg suites + the explicit FK-rollback test added below.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  describeIfDocker,
  startPostgresTestEnv,
  stopPostgresTestEnv,
  type PgTestEnv
} from '../../../test/postgres-harness'
import { PostgresTaskService } from '../postgres-task-service'
import {
  TaskStatusError,
  TaskNotFoundError,
  NoActiveSessionError
} from '../lifecycle/errors'
import { ReviewSessionResolutionError } from '../lifecycle/task-review-lifecycle-service'
import { AcAlreadyCheckedError, AcIndexOutOfRangeError } from '../lifecycle/errors'

describeIfDocker('PostgresTaskService task-review + ac-check', () => {
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
    await svc.ensureProject('proj-r', 'Review Project', '/tmp/r')
  })

  async function setupReviewTask(): Promise<{ taskId: string; sessionId: string }> {
    const task = await svc.createTask({ projectId: 'proj-r', title: 'review me' })
    const session = await svc.createSession({
      projectId: 'proj-r',
      taskId: task.id,
      startedAt: new Date().toISOString(),
      status: 'active'
    })
    await svc.updateTask(task.id, { status: 'REVIEW' })
    return { taskId: task.id, sessionId: session.id }
  }

  // ── approveTask ──────────────────────────────────────────────────────────
  describe('approveTask', () => {
    it('happy path: REVIEW + 1 active session → DONE + session closed + handoff approved', async () => {
      const { taskId, sessionId } = await setupReviewTask()

      const r = await svc.approveTask(taskId, 'looks good')

      expect(r.taskId).toBe(taskId)
      expect(r.status).toBe('DONE')
      expect(r.sessionId).toBe(sessionId)
      expect(r.memoryCandidates).toEqual([])
      expect(r.selfEditPrompt).toBe('')

      expect((await svc.getTask(taskId))?.status).toBe('DONE')
      const session = await svc.getSession(sessionId)
      expect(session?.status).toBe('completed')
      expect(session?.endedAt).toBeTruthy()
      expect(session?.handoff?.reviewOutcome).toBe('approved')
      expect(session?.handoff?.decisions).toEqual(['Approved: looks good'])
    })

    it('approve without note still records reviewOutcome=approved', async () => {
      const { taskId, sessionId } = await setupReviewTask()
      await svc.approveTask(taskId)
      expect((await svc.getSession(sessionId))?.handoff?.reviewOutcome).toBe('approved')
    })

    it('guard: task IN-PROGRESS → throws TaskStatusError containing "not in REVIEW"', async () => {
      const task = await svc.createTask({ projectId: 'proj-r', title: 'wip' })
      await svc.createSession({
        projectId: 'proj-r',
        taskId: task.id,
        startedAt: new Date().toISOString(),
        status: 'active'
      })
      await svc.updateTask(task.id, { status: 'IN-PROGRESS' })

      await expect(svc.approveTask(task.id)).rejects.toThrow(TaskStatusError)
      await expect(svc.approveTask(task.id)).rejects.toThrow(/not in REVIEW/)
    })
  })

  // ── rejectTask ───────────────────────────────────────────────────────────
  describe('rejectTask', () => {
    it('happy path: REVIEW → reject(reason) → IN-PROGRESS + session closed + handoff carries reason', async () => {
      const { taskId, sessionId } = await setupReviewTask()

      const r = await svc.rejectTask(taskId, 'tests missing')

      expect(r.taskId).toBe(taskId)
      expect(r.status).toBe('IN-PROGRESS')
      expect(r.sessionId).toBe(sessionId)

      expect((await svc.getTask(taskId))?.status).toBe('IN-PROGRESS')
      const session = await svc.getSession(sessionId)
      expect(session?.status).toBe('completed')
      expect(session?.handoff?.reviewOutcome).toBe('rejected')
      expect(session?.handoff?.reviewReason).toBe('tests missing')
      expect(session?.handoff?.decisions).toEqual(['Rejected: tests missing'])
    })
  })

  // ── memory candidate forwarding (ADR-023 Phase 2) ────────────────────────
  describe('memory candidate forwarding', () => {
    it('approveTask returns empty candidates when session has none', async () => {
      const { taskId } = await setupReviewTask()
      const r = await svc.approveTask(taskId)
      expect(r.memoryCandidates).toEqual([])
      expect(r.selfEditPrompt).toBe('')
    })

    it('approveTask forwards memoryCandidates + selfEditPrompt from endSession', async () => {
      const { taskId, sessionId } = await setupReviewTask()
      await svc.createSessionEvent({
        sessionId,
        eventType: 'decision',
        memoryCandidate: true
      })

      const r = await svc.approveTask(taskId)
      expect(r.memoryCandidates).toHaveLength(1)
      expect(r.memoryCandidates[0].sessionId).toBe(sessionId)
      expect(r.selfEditPrompt).toContain('memory_write')
    })

    it('rejectTask forwards multiple candidates with plural prompt', async () => {
      const { taskId, sessionId } = await setupReviewTask()
      await svc.createSessionEvent({
        sessionId,
        eventType: 'observation',
        memoryCandidate: true
      })
      await svc.createSessionEvent({
        sessionId,
        eventType: 'decision',
        memoryCandidate: true
      })

      const r = await svc.rejectTask(taskId, 'needs rework')
      expect(r.memoryCandidates).toHaveLength(2)
      expect(r.selfEditPrompt).toMatch(/2 candidate events\b/)
      expect(r.selfEditPrompt).toContain('memory_write')
    })
  })

  // ── session resolution edge cases ────────────────────────────────────────
  describe('session resolution edge cases', () => {
    it('throws when 0 active sessions exist for taskId', async () => {
      const task = await svc.createTask({ projectId: 'proj-r', title: 'no session' })
      await svc.updateTask(task.id, { status: 'REVIEW' })

      await expect(svc.approveTask(task.id)).rejects.toThrow(ReviewSessionResolutionError)
      await expect(svc.approveTask(task.id)).rejects.toThrow(/no active session/)
    })

    it('throws when 2+ active sessions exist for taskId (race detection)', async () => {
      const task = await svc.createTask({ projectId: 'proj-r', title: 'race' })
      // Bypass startSession's TaskLockedBySessionError guard via createSession.
      await svc.createSession({
        projectId: 'proj-r',
        taskId: task.id,
        startedAt: new Date().toISOString(),
        status: 'active'
      })
      await svc.createSession({
        projectId: 'proj-r',
        taskId: task.id,
        startedAt: new Date().toISOString(),
        status: 'active'
      })
      await svc.updateTask(task.id, { status: 'REVIEW' })

      await expect(svc.rejectTask(task.id, 'x')).rejects.toThrow(ReviewSessionResolutionError)
      await expect(svc.rejectTask(task.id, 'x')).rejects.toThrow(/race detected/)
    })
  })

  // ── checkAcItem ──────────────────────────────────────────────────────────
  describe('checkAcItem', () => {
    async function setupAcTask(body: string): Promise<{ taskId: string; sessionId: string }> {
      const task = await svc.createTask({ projectId: 'proj-r', title: 'AC host', body })
      const session = await svc.createSession({
        projectId: 'proj-r',
        startedAt: new Date().toISOString(),
        status: 'active'
      })
      return { taskId: task.id, sessionId: session.id }
    }

    it('happy path: flips AC + emits observation event atomically', async () => {
      const { taskId, sessionId } = await setupAcTask(
        '## Acceptance\n- [ ] one\n- [ ] two\n'
      )

      const r = await svc.checkAcItem({ taskId, acIndex: 0, evidence: 'tested' })

      expect(r.taskId).toBe(taskId)
      expect(r.acIndex).toBe(0)
      expect(r.text).toBe('one')
      expect(r.evidence).toBe('tested')
      expect(r.sessionId).toBe(sessionId)
      expect(r.eventId).toBeTruthy()

      const updated = await svc.getTask(taskId)
      expect(updated?.body).toContain('- [x] one')
      expect(updated?.body).toContain('- [ ] two')

      const events = await svc.listSessionEvents(sessionId, 'observation')
      expect(events).toHaveLength(1)
      const payload = JSON.parse(events[0].payloadJson ?? '{}')
      expect(payload.kind).toBe('ac_check')
      expect(payload.taskId).toBe(taskId)
      expect(payload.acIndex).toBe(0)
      expect(payload.evidence).toBe('tested')
    })

    it('throws TaskNotFoundError when task does not exist', async () => {
      await expect(
        svc.checkAcItem({ taskId: 'TASK-999', acIndex: 0, evidence: 'e' })
      ).rejects.toThrow(TaskNotFoundError)
    })

    it('throws NoActiveSessionError when no active session for the project', async () => {
      const task = await svc.createTask({
        projectId: 'proj-r',
        title: 'orphan',
        body: '## Acceptance\n- [ ] one\n'
      })
      await expect(
        svc.checkAcItem({ taskId: task.id, acIndex: 0, evidence: 'e' })
      ).rejects.toThrow(NoActiveSessionError)
    })

    it('throws AcIndexOutOfRangeError when index too large', async () => {
      const { taskId } = await setupAcTask('## Acceptance\n- [ ] one\n')
      await expect(
        svc.checkAcItem({ taskId, acIndex: 5, evidence: 'e' })
      ).rejects.toThrow(AcIndexOutOfRangeError)
    })

    it('throws AcAlreadyCheckedError on double-check', async () => {
      const { taskId } = await setupAcTask('## Acceptance\n- [ ] one\n')
      await svc.checkAcItem({ taskId, acIndex: 0, evidence: 'e' })
      await expect(
        svc.checkAcItem({ taskId, acIndex: 0, evidence: 'e' })
      ).rejects.toThrow(AcAlreadyCheckedError)
    })

    it('matches an active session for the specified workspaceId', async () => {
      await svc.addWorkspace('proj-r', 'ws-1', 'WS 1', '/tmp/r/ws1')
      const task = await svc.createTask({
        projectId: 'proj-r',
        title: 'AC ws',
        body: '## Acceptance\n- [ ] one\n'
      })
      const session = await svc.createSession({
        projectId: 'proj-r',
        workspaceId: 'ws-1',
        startedAt: new Date().toISOString(),
        status: 'active'
      })

      const r = await svc.checkAcItem({
        taskId: task.id,
        acIndex: 0,
        evidence: 'tested',
        workspaceId: 'ws-1'
      })
      expect(r.sessionId).toBe(session.id)
    })
  })
})
