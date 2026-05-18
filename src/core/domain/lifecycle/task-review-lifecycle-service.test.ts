import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { SqliteTaskService } from '../sqlite-task-service'
import { TaskStatusError } from './errors'
import { ReviewSessionResolutionError } from './task-review-lifecycle-service'

const TEST_DB = path.join(__dirname, '__test-task-review-lifecycle__.db')
let svc: SqliteTaskService

function setupReviewTask(): { taskId: string; sessionId: string } {
  const task = svc.createTask({ projectId: 'proj-r', title: 'review me' })
  const session = svc.createSession({ projectId: 'proj-r', taskId: task.id })
  svc.updateTask(task.id, { status: 'REVIEW' })
  return { taskId: task.id, sessionId: session.id }
}

beforeEach(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  svc = new SqliteTaskService(TEST_DB)
  svc.ensureProject('proj-r', 'Review Project', '/tmp/r')
})

afterEach(() => {
  svc.close()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
})

describe('approveTask', () => {
  it('happy path: REVIEW + 1 active session → DONE + session closed + handoff reviewOutcome=approved', () => {
    const { taskId, sessionId } = setupReviewTask()

    const r = svc.approveTask(taskId, 'looks good')

    expect(r).toEqual({
      taskId,
      status: 'DONE',
      sessionId,
      memoryCandidates: [],
      selfEditPrompt: ''
    })
    expect(svc.getTask(taskId)?.status).toBe('DONE')
    const session = svc.getSession(sessionId)
    expect(session?.status).toBe('completed')
    expect(session?.endedAt).toBeTruthy()
    expect(session?.handoff?.reviewOutcome).toBe('approved')
    expect(session?.handoff?.decisions).toEqual(['Approved: looks good'])
  })

  it('approve without note still records reviewOutcome=approved', () => {
    const { taskId, sessionId } = setupReviewTask()
    svc.approveTask(taskId)
    expect(svc.getSession(sessionId)?.handoff?.reviewOutcome).toBe('approved')
  })

  it('guard: task IN-PROGRESS → throws TaskStatusError containing "not in REVIEW"', () => {
    const task = svc.createTask({ projectId: 'proj-r', title: 'wip' })
    svc.createSession({ projectId: 'proj-r', taskId: task.id })
    svc.updateTask(task.id, { status: 'IN-PROGRESS' })

    expect(() => svc.approveTask(task.id)).toThrowError(TaskStatusError)
    expect(() => svc.approveTask(task.id)).toThrow(/not in REVIEW/)
  })
})

describe('rejectTask', () => {
  it('happy path: REVIEW → reject(reason) → IN-PROGRESS + session closed + handoff carries reason', () => {
    const { taskId, sessionId } = setupReviewTask()

    const r = svc.rejectTask(taskId, 'tests missing')

    expect(r).toEqual({
      taskId,
      status: 'IN-PROGRESS',
      sessionId,
      memoryCandidates: [],
      selfEditPrompt: ''
    })
    expect(svc.getTask(taskId)?.status).toBe('IN-PROGRESS')
    const session = svc.getSession(sessionId)
    expect(session?.status).toBe('completed')
    expect(session?.handoff?.reviewOutcome).toBe('rejected')
    expect(session?.handoff?.reviewReason).toBe('tests missing')
    expect(session?.handoff?.decisions).toEqual(['Rejected: tests missing'])
  })
})

describe('transaction rollback (atomicity)', () => {
  it('rolls back endSession when subsequent taskUpdate throws — session stays active, task stays REVIEW', () => {
    const { taskId, sessionId } = setupReviewTask()

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

    expect(() => svc.approveTask(taskId)).toThrow('simulated taskUpdate failure')

    lifecycle.tasks.update = origUpdate

    // The composite's explicit DONE update is the one that threw; both that AND endSession's
    // savepoint must have rolled back together (nested tx semantics).
    expect(stubCalls).toBeGreaterThan(0)
    expect(svc.getTask(taskId)?.status).toBe('REVIEW')
    const session = svc.getSession(sessionId)
    expect(session?.status).toBe('active')
    expect(session?.endedAt).toBeNull()
  })

  it('rolls back when endSession throws — task stays REVIEW, session stays active', () => {
    const { taskId, sessionId } = setupReviewTask()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lifecycle = (svc as any).taskReviewLifecycle
    const origEnd = lifecycle.sessionLifecycle.endSession.bind(lifecycle.sessionLifecycle)
    lifecycle.sessionLifecycle.endSession = () => {
      throw new Error('simulated endSession failure')
    }

    expect(() => svc.rejectTask(taskId, 'whatever')).toThrow('simulated endSession failure')

    lifecycle.sessionLifecycle.endSession = origEnd

    expect(svc.getTask(taskId)?.status).toBe('REVIEW')
    const session = svc.getSession(sessionId)
    expect(session?.status).toBe('active')
    expect(session?.endedAt).toBeNull()
  })
})

describe('memory candidate forwarding (Phase 2 — ADR-023)', () => {
  it('approveTask returns empty candidates + empty prompt when session has none', () => {
    const { taskId } = setupReviewTask()
    const r = svc.approveTask(taskId)
    expect(r.memoryCandidates).toEqual([])
    expect(r.selfEditPrompt).toBe('')
  })

  it('approveTask forwards memoryCandidates + selfEditPrompt from endSession', () => {
    const { taskId, sessionId } = setupReviewTask()
    svc.createSessionEvent({
      sessionId,
      eventType: 'decision',
      memoryCandidate: true
    })

    const r = svc.approveTask(taskId)
    expect(r.memoryCandidates).toHaveLength(1)
    expect(r.memoryCandidates[0].sessionId).toBe(sessionId)
    expect(r.selfEditPrompt).toContain('memory_write')
  })

  it('rejectTask forwards multiple candidates with plural prompt', () => {
    const { taskId, sessionId } = setupReviewTask()
    svc.createSessionEvent({ sessionId, eventType: 'observation', memoryCandidate: true })
    svc.createSessionEvent({ sessionId, eventType: 'decision', memoryCandidate: true })

    const r = svc.rejectTask(taskId, 'needs rework')
    expect(r.memoryCandidates).toHaveLength(2)
    expect(r.selfEditPrompt).toMatch(/2 candidate events\b/)
    expect(r.selfEditPrompt).toContain('memory_write')
  })
})

describe('session resolution edge cases', () => {
  it('throws when 0 active sessions exist for taskId', () => {
    const task = svc.createTask({ projectId: 'proj-r', title: 'no session' })
    svc.updateTask(task.id, { status: 'REVIEW' })

    expect(() => svc.approveTask(task.id)).toThrowError(ReviewSessionResolutionError)
    expect(() => svc.approveTask(task.id)).toThrow(/no active session/)
  })

  it('throws when 2+ active sessions exist for taskId (race detection)', () => {
    const task = svc.createTask({ projectId: 'proj-r', title: 'race' })
    // Create two active sessions bound to the same taskId via the repository facade
    // (bypassing startSession's TaskLockedBySessionError guard to simulate the race).
    svc.createSession({ projectId: 'proj-r', taskId: task.id })
    svc.createSession({ projectId: 'proj-r', taskId: task.id })
    svc.updateTask(task.id, { status: 'REVIEW' })

    expect(() => svc.rejectTask(task.id, 'x')).toThrowError(ReviewSessionResolutionError)
    expect(() => svc.rejectTask(task.id, 'x')).toThrow(/race detected/)
  })
})
