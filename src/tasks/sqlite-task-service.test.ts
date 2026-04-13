import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { SqliteTaskService } from './sqlite-task-service'
import * as fs from 'fs'
import * as path from 'path'

const TEST_DB = path.join(__dirname, '__test-tasks__.db')

describe('SqliteTaskService', () => {
  let svc: SqliteTaskService

  beforeAll(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
    svc = new SqliteTaskService(TEST_DB)
    await svc.initializeAsync()
    svc.ensureProject('test-proj', 'Test Project', '/tmp/test')
  })

  afterAll(() => {
    svc.close()
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  })

  // ── Task CRUD ──────────────────────────────────────────────────────────

  it('createTask + getTask', () => {
    const task = svc.createTask({
      id: 'TASK-001',
      projectId: 'test-proj',
      title: 'First task',
      priority: 'high'
    })
    expect(task.id).toBe('TASK-001')
    expect(task.status).toBe('TODO')
    expect(task.priority).toBe('high')

    const fetched = svc.getTask('TASK-001')
    expect(fetched).not.toBeNull()
    expect(fetched!.title).toBe('First task')
  })

  it('getTask returns null for missing', () => {
    expect(svc.getTask('TASK-999')).toBeNull()
  })

  it('updateTask changes fields', () => {
    const updated = svc.updateTask('TASK-001', {
      status: 'IN-PROGRESS',
      priority: 'critical',
      labels: ['urgent', 'bug']
    })
    expect(updated.status).toBe('IN-PROGRESS')
    expect(updated.priority).toBe('critical')
    expect(updated.labels).toEqual(['urgent', 'bug'])
    expect(updated.title).toBe('First task')
  })

  it('updateTask throws for missing', () => {
    expect(() => svc.updateTask('TASK-999', { title: 'x' })).toThrow('not found')
  })

  it('findTasks filters correctly', () => {
    svc.createTask({ id: 'TASK-002', projectId: 'test-proj', title: 'Second task', status: 'TODO' })
    svc.createTask({ id: 'TASK-003', projectId: 'test-proj', title: 'Third task', status: 'DONE' })

    const inProgress = svc.findTasks({ projectId: 'test-proj', status: 'IN-PROGRESS' })
    expect(inProgress.length).toBe(1)
    expect(inProgress[0].id).toBe('TASK-001')

    const all = svc.findTasks({ projectId: 'test-proj' })
    expect(all.length).toBe(3)

    const search = svc.findTasks({ query: 'Second' })
    expect(search.length).toBe(1)
    expect(search[0].id).toBe('TASK-002')

    const limited = svc.findTasks({ projectId: 'test-proj', limit: 2 })
    expect(limited.length).toBe(2)
  })

  it('deleteTask removes task + cascades deps', () => {
    svc.createTask({ id: 'TASK-DEL', projectId: 'test-proj', title: 'To delete' })
    svc.addDependency('TASK-001', 'TASK-DEL')

    svc.deleteTask('TASK-DEL')
    expect(svc.getTask('TASK-DEL')).toBeNull()
    expect(svc.getDependencies('TASK-001').length).toBe(0)
  })

  // ── Subtasks ───────────────────────────────────────────────────────────

  it('subtasks via parentTaskId', () => {
    svc.createTask({ id: 'TASK-SUB1', projectId: 'test-proj', title: 'Sub 1', parentTaskId: 'TASK-001' })
    svc.createTask({ id: 'TASK-SUB2', projectId: 'test-proj', title: 'Sub 2', parentTaskId: 'TASK-001' })

    const subs = svc.getSubtasks('TASK-001')
    expect(subs.length).toBe(2)
    expect(subs.map(s => s.id).sort()).toEqual(['TASK-SUB1', 'TASK-SUB2'])
  })

  // ── Epics ──────────────────────────────────────────────────────────────

  it('createEpic + getEpic', () => {
    const epic = svc.createEpic({ id: 'EPIC-001', projectId: 'test-proj', title: 'MVP' })
    expect(epic.id).toBe('EPIC-001')
    expect(epic.status).toBe('TODO')

    const fetched = svc.getEpic('EPIC-001')
    expect(fetched).not.toBeNull()
  })

  it('findEpics by project', () => {
    svc.createEpic({ id: 'EPIC-002', projectId: 'test-proj', title: 'Phase 2' })
    const epics = svc.findEpics('test-proj')
    expect(epics.length).toBe(2)
  })

  it('getEpicProgress', () => {
    svc.updateTask('TASK-001', { epicId: 'EPIC-001' })
    svc.updateTask('TASK-002', { epicId: 'EPIC-001' })
    svc.updateTask('TASK-003', { epicId: 'EPIC-001' })

    const progress = svc.getEpicProgress('EPIC-001')
    expect(progress.total).toBe(3)
    expect(progress.done).toBe(1)
  })

  it('deleteEpic unlinks tasks', () => {
    svc.deleteEpic('EPIC-002')
    expect(svc.getEpic('EPIC-002')).toBeNull()
  })

  // ── Dependencies ───────────────────────────────────────────────────────

  it('addDependency + getDependencies', () => {
    svc.addDependency('TASK-001', 'TASK-002')
    svc.addDependency('TASK-001', 'TASK-003')

    const deps = svc.getDependencies('TASK-001')
    expect(deps.length).toBe(2)
  })

  it('addDependency is idempotent', () => {
    svc.addDependency('TASK-001', 'TASK-002')
    const deps = svc.getDependencies('TASK-001')
    expect(deps.length).toBe(2)
  })

  it('removeDependency', () => {
    svc.removeDependency('TASK-001', 'TASK-002')
    const deps = svc.getDependencies('TASK-001')
    expect(deps.length).toBe(1)
  })

  // ── Daily focus ────────────────────────────────────────────────────────

  it('pinned tasks', () => {
    svc.updateTask('TASK-001', { pinned: true })
    const pinned = svc.getPinnedTasks()
    expect(pinned.length).toBe(1)
    expect(pinned[0].id).toBe('TASK-001')
  })

  it('due tasks', () => {
    svc.updateTask('TASK-002', { dueDate: '2026-04-13' })
    const due = svc.getDueTasks('2026-04-13')
    expect(due.length).toBe(1)
    expect(due[0].id).toBe('TASK-002')
  })
})
