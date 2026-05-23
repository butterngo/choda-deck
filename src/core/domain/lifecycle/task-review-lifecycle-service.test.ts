import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { SqliteTaskService } from '../sqlite-task-service'
import { TaskStatusError } from './errors'
import { ReviewSessionResolutionError } from './task-review-lifecycle-service'

const TEST_DB = path.join(__dirname, '__test-task-review-lifecycle__.db')
let svc: SqliteTaskService

async function setupReviewTask(): Promise<{ taskId: string; sessionId: string }> {
  const task = await svc.createTask({ projectId: 'proj-r', title: 'review me' })
  const session = await svc.createSession({ projectId: 'proj-r', taskId: task.id })
  await svc.updateTask(task.id, { status: 'REVIEW' })
  return { taskId: task.id, sessionId: session.id }
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  svc = new SqliteTaskService(TEST_DB)
  await svc.ensureProject('proj-r', 'Review Project', '/tmp/r')
})

afterEach(async () => {
  await svc.close()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
})

describe('approveTask', () => {
  it('happy path: REVIEW + 1 active session → DONE + session closed + handoff reviewOutcome=approved', async () => {
    const { taskId, sessionId } = await setupReviewTask()

    const r = await svc.approveTask(taskId, 'looks good')

    expect(r).toEqual({
      taskId,
      status: 'DONE',
      sessionId,
      memoryCandidates: [],
      selfEditPrompt: ''
    })
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
    await svc.createSession({ projectId: 'proj-r', taskId: task.id })
    await svc.updateTask(task.id, { status: 'IN-PROGRESS' })

    await expect(svc.approveTask(task.id)).rejects.toThrow(TaskStatusError)
    await expect(svc.approveTask(task.id)).rejects.toThrow(/not in REVIEW/)
  })
})

describe('rejectTask', () => {
  it('happy path: REVIEW → reject(reason) → IN-PROGRESS + session closed + handoff carries reason', async () => {
    const { taskId, sessionId } = await setupReviewTask()

    const r = await svc.rejectTask(taskId, 'tests missing')

    expect(r).toEqual({
      taskId,
      status: 'IN-PROGRESS',
      sessionId,
      memoryCandidates: [],
      selfEditPrompt: ''
    })
    expect((await svc.getTask(taskId))?.status).toBe('IN-PROGRESS')
    const session = await svc.getSession(sessionId)
    expect(session?.status).toBe('completed')
    expect(session?.handoff?.reviewOutcome).toBe('rejected')
    expect(session?.handoff?.reviewReason).toBe('tests missing')
    expect(session?.handoff?.decisions).toEqual(['Rejected: tests missing'])
  })
})

describe('transaction rollback (atomicity)', () => {
  it('rolls back endSession when subsequent taskUpdate throws — session stays active, task stays REVIEW', async () => {
    const { taskId, sessionId } = await setupReviewTask()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lifecycle = (svc as any).taskReviewLifecycle
    const origUpdate = lifecycle.tasks.update.bind(lifecycle.tasks)
    let stubCalls = 0
    lifecycle.tasks.update = (id: string, input: Record<string, unknown>) => {
      // Only intercept the post-endSession status flip; let endSession's internal task.update through.
      if (input.status === 'DONE' && id === taskId) {
        stubCalls++
        throw new Error('simulated taskUpdate failure')
      }
      return origUpdate(id, input)
    }

    await expect(svc.approveTask(taskId)).rejects.toThrow('simulated taskUpdate failure')

    lifecycle.tasks.update = origUpdate

    // The composite's explicit DONE update is the one that threw; both that AND endSession's
    // savepoint must have rolled back together (nested tx semantics).
    expect(stubCalls).toBeGreaterThan(0)
    expect((await svc.getTask(taskId))?.status).toBe('REVIEW')
    const session = await svc.getSession(sessionId)
    expect(session?.status).toBe('active')
    expect(session?.endedAt).toBeNull()
  })

  it('rolls back when endSession throws — task stays REVIEW, session stays active', async () => {
    const { taskId, sessionId } = await setupReviewTask()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lifecycle = (svc as any).taskReviewLifecycle
    const origEnd = lifecycle.sessionLifecycle.endSessionSync.bind(lifecycle.sessionLifecycle)
    lifecycle.sessionLifecycle.endSessionSync = () => {
      throw new Error('simulated endSession failure')
    }

    await expect(svc.rejectTask(taskId, 'whatever')).rejects.toThrow('simulated endSession failure')

    lifecycle.sessionLifecycle.endSessionSync = origEnd

    expect((await svc.getTask(taskId))?.status).toBe('REVIEW')
    const session = await svc.getSession(sessionId)
    expect(session?.status).toBe('active')
    expect(session?.endedAt).toBeNull()
  })
})

describe('memory candidate forwarding (Phase 2 — ADR-023)', () => {
  it('approveTask returns empty candidates + empty prompt when session has none', async () => {
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
    await svc.createSessionEvent({ sessionId, eventType: 'observation', memoryCandidate: true })
    await svc.createSessionEvent({ sessionId, eventType: 'decision', memoryCandidate: true })

    const r = await svc.rejectTask(taskId, 'needs rework')
    expect(r.memoryCandidates).toHaveLength(2)
    expect(r.selfEditPrompt).toMatch(/2 candidate events\b/)
    expect(r.selfEditPrompt).toContain('memory_write')
  })
})

describe('session resolution edge cases', () => {
  it('throws when 0 active sessions exist for taskId', async () => {
    const task = await svc.createTask({ projectId: 'proj-r', title: 'no session' })
    await svc.updateTask(task.id, { status: 'REVIEW' })

    await expect(svc.approveTask(task.id)).rejects.toThrow(ReviewSessionResolutionError)
    await expect(svc.approveTask(task.id)).rejects.toThrow(/no active session/)
  })

  it('throws when 2+ active sessions exist for taskId (race detection)', async () => {
    const task = await svc.createTask({ projectId: 'proj-r', title: 'race' })
    // Create two active sessions bound to the same taskId via the repository facade
    // (bypassing startSession's TaskLockedBySessionError guard to simulate the race).
    await svc.createSession({ projectId: 'proj-r', taskId: task.id })
    await svc.createSession({ projectId: 'proj-r', taskId: task.id })
    await svc.updateTask(task.id, { status: 'REVIEW' })

    await expect(svc.rejectTask(task.id, 'x')).rejects.toThrow(ReviewSessionResolutionError)
    await expect(svc.rejectTask(task.id, 'x')).rejects.toThrow(/race detected/)
  })
})
