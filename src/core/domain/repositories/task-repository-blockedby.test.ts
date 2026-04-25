import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { SqliteTaskService } from '../sqlite-task-service'
import { TaskBlockedError } from '../task-types'

const TEST_DB = path.join(__dirname, '__blocked-by-test__.db')

describe('blockedBy + DONE guard', () => {
  let svc: SqliteTaskService

  beforeEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
    svc = new SqliteTaskService(TEST_DB)
    svc.ensureProject('p', 'P', '/tmp/p')
  })

  afterEach(() => {
    svc.close()
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  })

  it('createTask with blockedBy populates the field on read', () => {
    svc.createTask({ id: 'T1', projectId: 'p', title: 'A' })
    const t2 = svc.createTask({ id: 'T2', projectId: 'p', title: 'B', blockedBy: ['T1'] })
    expect(t2.blockedBy).toEqual(['T1'])

    const fetched = svc.getTask('T2')
    expect(fetched?.blockedBy).toEqual(['T1'])
  })

  it('updateTask blockedBy=[] clears existing blockers', () => {
    svc.createTask({ id: 'T1', projectId: 'p', title: 'A' })
    svc.createTask({ id: 'T2', projectId: 'p', title: 'B', blockedBy: ['T1'] })
    const updated = svc.updateTask('T2', { blockedBy: [] })
    expect(updated.blockedBy).toEqual([])
  })

  it('blockedBy rejects unknown task', () => {
    svc.createTask({ id: 'T1', projectId: 'p', title: 'A' })
    expect(() => svc.updateTask('T1', { blockedBy: ['T-MISSING'] })).toThrow('unknown task')
  })

  it('blockedBy rejects self-reference', () => {
    svc.createTask({ id: 'T1', projectId: 'p', title: 'A' })
    expect(() => svc.updateTask('T1', { blockedBy: ['T1'] })).toThrow('cannot be blocked by itself')
  })

  it('blockedBy rejects direct cycle', () => {
    svc.createTask({ id: 'T1', projectId: 'p', title: 'A' })
    svc.createTask({ id: 'T2', projectId: 'p', title: 'B', blockedBy: ['T1'] })
    // T2 depends on T1; trying to make T1 depend on T2 → cycle
    expect(() => svc.updateTask('T1', { blockedBy: ['T2'] })).toThrow('Cycle detected')
  })

  it('updateTask DONE blocked by non-DONE dependency', () => {
    svc.createTask({ id: 'T1', projectId: 'p', title: 'Blocker', status: 'TODO' })
    svc.createTask({ id: 'T2', projectId: 'p', title: 'Blocked', blockedBy: ['T1'] })

    let err: TaskBlockedError | null = null
    try {
      svc.updateTask('T2', { status: 'DONE' })
    } catch (e) {
      err = e as TaskBlockedError
    }
    expect(err).toBeInstanceOf(TaskBlockedError)
    expect(err?.blockers.map((b) => b.id)).toEqual(['T1'])
    expect(err?.blockers[0].type).toBe('dependency')
  })

  it('updateTask DONE blocked by non-DONE subtask', () => {
    svc.createTask({ id: 'P1', projectId: 'p', title: 'Parent' })
    svc.createTask({ id: 'C1', projectId: 'p', title: 'Child', parentTaskId: 'P1' })

    let err: TaskBlockedError | null = null
    try {
      svc.updateTask('P1', { status: 'DONE' })
    } catch (e) {
      err = e as TaskBlockedError
    }
    expect(err).toBeInstanceOf(TaskBlockedError)
    expect(err?.blockers.map((b) => b.id)).toEqual(['C1'])
    expect(err?.blockers[0].type).toBe('subtask')
  })

  it('updateTask DONE succeeds when blockers DONE/CANCELLED', () => {
    svc.createTask({ id: 'T1', projectId: 'p', title: 'A' })
    svc.createTask({ id: 'T2', projectId: 'p', title: 'B', status: 'CANCELLED' })
    svc.createTask({ id: 'T3', projectId: 'p', title: 'C', blockedBy: ['T1', 'T2'] })

    svc.updateTask('T1', { status: 'DONE' })
    const t3 = svc.updateTask('T3', { status: 'DONE' })
    expect(t3.status).toBe('DONE')
  })

  it('updateTask non-DONE status updates skip blocker check', () => {
    svc.createTask({ id: 'T1', projectId: 'p', title: 'A', status: 'TODO' })
    svc.createTask({ id: 'T2', projectId: 'p', title: 'B', blockedBy: ['T1'] })
    const updated = svc.updateTask('T2', { status: 'IN-PROGRESS' })
    expect(updated.status).toBe('IN-PROGRESS')
  })

  it('updateTask DONE→DONE no-op skips check', () => {
    svc.createTask({ id: 'T1', projectId: 'p', title: 'A', status: 'DONE' })
    svc.createTask({ id: 'T2', projectId: 'p', title: 'B', status: 'DONE', blockedBy: ['T1'] })
    // Already DONE — guard should not re-trigger even if we re-set to DONE
    const updated = svc.updateTask('T2', { status: 'DONE', title: 'B-renamed' })
    expect(updated.status).toBe('DONE')
    expect(updated.title).toBe('B-renamed')
  })

  it('READY filter excludes tasks with non-DONE subtasks', () => {
    svc.createTask({ id: 'P1', projectId: 'p', title: 'Parent', status: 'READY' })
    svc.createTask({
      id: 'C1',
      projectId: 'p',
      title: 'Child',
      parentTaskId: 'P1',
      status: 'TODO'
    })
    const ready = svc.findTasks({ projectId: 'p', status: 'READY' })
    expect(ready.find((t) => t.id === 'P1')).toBeUndefined()
  })

  it('READY filter excludes tasks with non-DONE blockedBy', () => {
    svc.createTask({ id: 'T1', projectId: 'p', title: 'Blocker', status: 'TODO' })
    svc.createTask({
      id: 'T2',
      projectId: 'p',
      title: 'Blocked',
      status: 'READY',
      blockedBy: ['T1']
    })
    const ready = svc.findTasks({ projectId: 'p', status: 'READY' })
    expect(ready.find((t) => t.id === 'T2')).toBeUndefined()
  })

  it('READY filter includes task once blockers all DONE', () => {
    svc.createTask({ id: 'T1', projectId: 'p', title: 'Blocker', status: 'TODO' })
    svc.createTask({
      id: 'T2',
      projectId: 'p',
      title: 'Blocked',
      status: 'READY',
      blockedBy: ['T1']
    })
    svc.updateTask('T1', { status: 'DONE' })
    const ready = svc.findTasks({ projectId: 'p', status: 'READY' })
    expect(ready.find((t) => t.id === 'T2')).toBeDefined()
  })

  it('TaskBlockedError message lists all blockers', () => {
    svc.createTask({ id: 'P1', projectId: 'p', title: 'Parent' })
    svc.createTask({ id: 'C1', projectId: 'p', title: 'Child A', parentTaskId: 'P1' })
    svc.createTask({ id: 'C2', projectId: 'p', title: 'Child B', parentTaskId: 'P1' })
    svc.createTask({ id: 'D1', projectId: 'p', title: 'Dep' })
    svc.updateTask('P1', { blockedBy: ['D1'] })

    try {
      svc.updateTask('P1', { status: 'DONE' })
      throw new Error('expected throw')
    } catch (e) {
      const err = e as TaskBlockedError
      expect(err).toBeInstanceOf(TaskBlockedError)
      const ids = err.blockers.map((b) => b.id).sort()
      expect(ids).toEqual(['C1', 'C2', 'D1'])
      expect(err.message).toContain('3 blocker(s)')
    }
  })
})
