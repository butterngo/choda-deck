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
    expect(epic.title).toBe('MVP')

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

  // ── Phases ─────────────────────────────────────────────────────────────

  it('createPhase + getPhase', () => {
    const phase = svc.createPhase({ id: 'PH-A', projectId: 'test-proj', title: 'Phase A', position: 1 })
    expect(phase.id).toBe('PH-A')
    expect(phase.status).toBe('open')
    expect(phase.position).toBe(1)
  })

  it('updatePhase', () => {
    const updated = svc.updatePhase('PH-A', { status: 'closed', targetDate: '2026-06-01' })
    expect(updated.status).toBe('closed')
    expect(updated.targetDate).toBe('2026-06-01')
  })

  it('findPhases ordered by position', () => {
    svc.createPhase({ id: 'PH-B', projectId: 'test-proj', title: 'Phase B', position: 2 })
    svc.updatePhase('PH-A', { status: 'open' })
    const phases = svc.findPhases('test-proj')
    expect(phases.length).toBe(2)
    expect(phases[0].id).toBe('PH-A')
    expect(phases[1].id).toBe('PH-B')
  })

  it('deletePhase unlinks features', () => {
    svc.deletePhase('PH-B')
    expect(svc.getPhase('PH-B')).toBeNull()
  })

  // ── Features ───────────────────────────────────────────────────────────

  it('createFeature + getFeature', () => {
    const feat = svc.createFeature({ id: 'FEAT-001', projectId: 'test-proj', phaseId: 'PH-A', title: 'Schema', priority: 'critical' })
    expect(feat.id).toBe('FEAT-001')
    expect(feat.phaseId).toBe('PH-A')
    expect(feat.priority).toBe('critical')
  })

  it('findFeaturesByPhase', () => {
    svc.createFeature({ id: 'FEAT-002', projectId: 'test-proj', phaseId: 'PH-A', title: 'Roadmap' })
    const feats = svc.findFeaturesByPhase('PH-A')
    expect(feats.length).toBe(2)
  })

  it('deleteFeature unlinks epics', () => {
    svc.createFeature({ id: 'FEAT-DEL', projectId: 'test-proj', title: 'To delete' })
    svc.updateEpic('EPIC-001', { featureId: 'FEAT-DEL' })
    svc.deleteFeature('FEAT-DEL')
    const epic = svc.getEpic('EPIC-001')!
    expect(epic.featureId).toBeNull()
  })

  // ── Derived progress ──────────────────────────────────────────────────

  it('epic derived progress has status', () => {
    const progress = svc.getEpicProgress('EPIC-001')
    expect(progress.status).toBe('active')
    expect(progress.percent).toBeGreaterThan(0)
    expect(progress.inProgress).toBeGreaterThanOrEqual(0)
  })

  it('feature derived progress', () => {
    svc.updateEpic('EPIC-001', { featureId: 'FEAT-001' })
    const progress = svc.getFeatureProgress('FEAT-001')
    expect(progress.total).toBe(3)
    expect(progress.status).toBe('active')
  })

  it('phase derived progress', () => {
    const progress = svc.getPhaseProgress('PH-A')
    expect(progress.total).toBe(3)
    expect(progress.status).toBe('active')
  })

  it('empty epic is planned', () => {
    svc.createEpic({ id: 'EPIC-EMPTY', projectId: 'test-proj', title: 'Empty' })
    const progress = svc.getEpicProgress('EPIC-EMPTY')
    expect(progress.status).toBe('planned')
    expect(progress.percent).toBe(0)
  })

  // ── Documents ──────────────────────────────────────────────────────────

  it('createDocument + getDocument', () => {
    const doc = svc.createDocument({ id: 'ADR-001', projectId: 'test-proj', type: 'adr', title: 'Use SQLite' })
    expect(doc.id).toBe('ADR-001')
    expect(doc.type).toBe('adr')
  })

  it('findDocuments by type', () => {
    svc.createDocument({ id: 'SPEC-001', projectId: 'test-proj', type: 'spec', title: 'API spec' })
    const adrs = svc.findDocuments('test-proj', 'adr')
    expect(adrs.length).toBe(1)
    const all = svc.findDocuments('test-proj')
    expect(all.length).toBe(2)
  })

  it('deleteDocument removes tags', () => {
    svc.addTag('ADR-001', 'sqlite')
    svc.deleteDocument('ADR-001')
    expect(svc.getDocument('ADR-001')).toBeNull()
    expect(svc.getTags('ADR-001')).toEqual([])
  })

  // ── Tags ──────────────────────────────────────────────────────────────

  it('addTag + getTags', () => {
    svc.addTag('TASK-001', 'electron')
    svc.addTag('TASK-001', 'react')
    const tags = svc.getTags('TASK-001')
    expect(tags).toEqual(['electron', 'react'])
  })

  it('addTag is idempotent', () => {
    svc.addTag('TASK-001', 'electron')
    expect(svc.getTags('TASK-001').length).toBe(2)
  })

  it('removeTag', () => {
    svc.removeTag('TASK-001', 'react')
    expect(svc.getTags('TASK-001')).toEqual(['electron'])
  })

  it('findByTag', () => {
    svc.addTag('TASK-002', 'electron')
    const items = svc.findByTag('electron')
    expect(items).toContain('TASK-001')
    expect(items).toContain('TASK-002')
  })

  // ── Relationships ─────────────────────────────────────────────────────

  it('addRelationship + getRelationships', () => {
    svc.addRelationship('TASK-001', 'FEAT-001', 'IMPLEMENTS')
    svc.addRelationship('TASK-001', 'TASK-002', 'DEPENDS_ON')
    const rels = svc.getRelationships('TASK-001')
    // TASK-001 has: DEPENDS_ON TASK-003 (from earlier dep tests) + IMPLEMENTS FEAT-001 + DEPENDS_ON TASK-002
    expect(rels.length).toBe(3)
  })

  it('addRelationship is idempotent', () => {
    svc.addRelationship('TASK-001', 'FEAT-001', 'IMPLEMENTS')
    expect(svc.getRelationships('TASK-001').length).toBe(3)
  })

  it('getRelationshipsFrom with type filter', () => {
    const deps = svc.getRelationshipsFrom('TASK-001', 'DEPENDS_ON')
    expect(deps.length).toBe(2) // TASK-002 + TASK-003
  })

  it('removeRelationship', () => {
    svc.removeRelationship('TASK-001', 'TASK-002', 'DEPENDS_ON')
    svc.removeRelationship('TASK-001', 'TASK-003', 'DEPENDS_ON')
    const rels = svc.getRelationshipsFrom('TASK-001', 'DEPENDS_ON')
    expect(rels.length).toBe(0)
  })
})
