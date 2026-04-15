import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { SqliteTaskService } from './sqlite-task-service'
import * as fs from 'fs'
import * as path from 'path'

const TEST_DB = path.join(__dirname, '__test-tasks__.db')

describe('SqliteTaskService', () => {
  let svc: SqliteTaskService

  beforeAll(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
    svc = new SqliteTaskService(TEST_DB)
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

  // ── Task → Feature link ─────────────────────────────────────────────

  it('task links to feature via featureId', () => {
    svc.createFeature({ id: 'FEAT-LINK', projectId: 'test-proj', title: 'Link test' })
    svc.updateTask('TASK-001', { featureId: 'FEAT-LINK' })
    svc.updateTask('TASK-002', { featureId: 'FEAT-LINK' })
    svc.updateTask('TASK-003', { featureId: 'FEAT-LINK' })

    const progress = svc.getFeatureProgress('FEAT-LINK')
    expect(progress.total).toBe(3)
    expect(progress.done).toBe(1)

    const task = svc.getTask('TASK-001')!
    expect(task.featureId).toBe('FEAT-LINK')
  })

  it('findTasks filters by featureId', () => {
    const tasks = svc.findTasks({ featureId: 'FEAT-LINK' })
    expect(tasks.length).toBe(3)
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
    const updated = svc.updatePhase('PH-A', { status: 'closed', startDate: '2026-04-01' })
    expect(updated.status).toBe('closed')
    expect(updated.startDate).toBe('2026-04-01')
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

  it('deleteFeature unlinks tasks', () => {
    svc.createFeature({ id: 'FEAT-DEL', projectId: 'test-proj', title: 'To delete' })
    svc.createTask({ id: 'TASK-FDEL', projectId: 'test-proj', title: 'Linked', featureId: 'FEAT-DEL' })
    svc.deleteFeature('FEAT-DEL')
    const task = svc.getTask('TASK-FDEL')!
    expect(task.featureId).toBeNull()
  })

  // ── Derived progress ──────────────────────────────────────────────────

  it('feature derived progress via tasks', () => {
    // FEAT-001 is in PH-A, link tasks to it
    svc.updateTask('TASK-001', { featureId: 'FEAT-001' })
    svc.updateTask('TASK-002', { featureId: 'FEAT-001' })
    svc.updateTask('TASK-003', { featureId: 'FEAT-001' })
    const progress = svc.getFeatureProgress('FEAT-001')
    expect(progress.total).toBe(3)
    expect(progress.status).toBe('active')
  })

  it('phase derived progress via features → tasks', () => {
    const progress = svc.getPhaseProgress('PH-A')
    expect(progress.total).toBe(3)
    expect(progress.status).toBe('active')
  })

  it('empty feature is planned', () => {
    svc.createFeature({ id: 'FEAT-EMPTY', projectId: 'test-proj', title: 'Empty' })
    const progress = svc.getFeatureProgress('FEAT-EMPTY')
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

  // ── Sessions (M1) ──────────────────────────────────────────────────────

  it('createSession + getSession', () => {
    const s = svc.createSession({
      id: 'SESSION-001',
      projectId: 'test-proj',
      handoff: { commits: ['abc123'], resumePoint: 'TASK-501' }
    })
    expect(s.id).toBe('SESSION-001')
    expect(s.status).toBe('active')
    expect(s.handoff?.resumePoint).toBe('TASK-501')

    const fetched = svc.getSession('SESSION-001')
    expect(fetched?.handoff?.commits).toEqual(['abc123'])
  })

  it('getActiveSession returns latest active', () => {
    svc.createSession({ id: 'SESSION-002', projectId: 'test-proj' })
    const active = svc.getActiveSession('test-proj')
    expect(active).not.toBeNull()
    expect(['SESSION-001', 'SESSION-002']).toContain(active!.id)
  })

  it('updateSession marks completed', () => {
    const updated = svc.updateSession('SESSION-001', {
      status: 'completed',
      endedAt: new Date().toISOString(),
      handoff: { decisions: ['chose better-sqlite3'] }
    })
    expect(updated.status).toBe('completed')
    expect(updated.endedAt).not.toBeNull()
    expect(updated.handoff?.decisions).toEqual(['chose better-sqlite3'])
  })

  it('findSessions filters by status', () => {
    const active = svc.findSessions('test-proj', 'active')
    expect(active.every(s => s.status === 'active')).toBe(true)
    const all = svc.findSessions('test-proj')
    expect(all.length).toBeGreaterThanOrEqual(active.length)
  })

  it('sessions FK rejects unknown project', () => {
    expect(() => svc.createSession({ projectId: 'nonexistent-proj' })).toThrow()
  })

  // ── ContextSources (M1) ────────────────────────────────────────────────

  it('createContextSource + getContextSource', () => {
    const src = svc.createContextSource({
      id: 'CTXSRC-001',
      projectId: 'test-proj',
      sourceType: 'file',
      sourcePath: 'docs/architecture.md',
      label: 'System Architecture',
      category: 'how',
      priority: 10
    })
    expect(src.priority).toBe(10)
    expect(src.isActive).toBe(true)
    expect(svc.getContextSource('CTXSRC-001')?.label).toBe('System Architecture')
  })

  it('findContextSources orders by priority', () => {
    svc.createContextSource({
      id: 'CTXSRC-002',
      projectId: 'test-proj',
      sourceType: 'file',
      sourcePath: 'CLAUDE.md',
      label: 'Project Conventions',
      category: 'how',
      priority: 5
    })
    const sources = svc.findContextSources('test-proj')
    expect(sources[0].id).toBe('CTXSRC-002')
    expect(sources[1].id).toBe('CTXSRC-001')
  })

  it('updateContextSource toggles is_active', () => {
    const updated = svc.updateContextSource('CTXSRC-001', { isActive: false })
    expect(updated.isActive).toBe(false)
    const active = svc.findContextSources('test-proj', true)
    expect(active.find(s => s.id === 'CTXSRC-001')).toBeUndefined()
  })

  it('context_sources FK rejects unknown project', () => {
    expect(() => svc.createContextSource({
      projectId: 'nonexistent-proj',
      sourceType: 'file',
      sourcePath: 'x.md',
      label: 'x',
      category: 'what'
    })).toThrow()
  })

  // ── Conversations (M1 / TASK-504) ──────────────────────────────────────

  it('createConversation + getConversation + participants', () => {
    const c = svc.createConversation({
      id: 'CONV-001',
      projectId: 'test-proj',
      title: 'Pick DB engine',
      createdBy: 'ARCH',
      participants: [
        { name: 'ARCH', type: 'role', role: 'requester' },
        { name: 'DEV', type: 'role', role: 'reviewer' }
      ]
    })
    expect(c.status).toBe('open')
    expect(c.createdBy).toBe('ARCH')

    const parts = svc.getConversationParticipants('CONV-001')
    expect(parts.length).toBe(2)
    expect(parts.find(p => p.name === 'ARCH')?.role).toBe('requester')
    expect(parts.find(p => p.name === 'DEV')?.type).toBe('role')
  })

  it('addConversationMessage + getConversationMessages ordered', () => {
    svc.addConversationMessage({
      id: 'MSG-001',
      conversationId: 'CONV-001',
      authorName: 'ARCH',
      content: 'Should we use sql.js or better-sqlite3?',
      messageType: 'question'
    })
    svc.addConversationMessage({
      id: 'MSG-002',
      conversationId: 'CONV-001',
      authorName: 'DEV',
      content: 'better-sqlite3 — sync API, no WASM',
      messageType: 'answer'
    })
    const msgs = svc.getConversationMessages('CONV-001')
    expect(msgs.length).toBe(2)
    expect(msgs[0].id).toBe('MSG-001')
    expect(msgs[0].authorName).toBe('ARCH')
    expect(msgs[1].messageType).toBe('answer')
  })

  it('addConversationMessage with metadata persists JSON', () => {
    svc.addConversationMessage({
      id: 'MSG-003',
      conversationId: 'CONV-001',
      authorName: 'DEV',
      content: '3 options',
      messageType: 'proposal',
      metadata: {
        options: [
          { id: 'A', description: 'remove', tradeoff: 'breaking' },
          { id: 'B', description: 'slim', tradeoff: 'complex' }
        ]
      }
    })
    const msg = svc.getConversationMessages('CONV-001').find(m => m.id === 'MSG-003')!
    expect(msg.metadata?.options?.length).toBe(2)
    expect(msg.metadata?.options?.[0].id).toBe('A')
  })

  it('updateConversation records decision', () => {
    const decidedAt = new Date().toISOString()
    const updated = svc.updateConversation('CONV-001', {
      status: 'decided',
      decisionSummary: 'Use better-sqlite3',
      decidedAt
    })
    expect(updated.status).toBe('decided')
    expect(updated.decisionSummary).toBe('Use better-sqlite3')
    expect(updated.decidedAt).toBe(decidedAt)
  })

  it('linkConversation + findConversationsByLink', () => {
    svc.linkConversation('CONV-001', 'task', 'TASK-501')
    const links = svc.getConversationLinks('CONV-001')
    expect(links.length).toBe(1)
    expect(links[0].linkedId).toBe('TASK-501')

    const convs = svc.findConversationsByLink('task', 'TASK-501')
    expect(convs.length).toBe(1)
    expect(convs[0].id).toBe('CONV-001')
  })

  it('linkConversation is idempotent', () => {
    svc.linkConversation('CONV-001', 'task', 'TASK-501')
    expect(svc.getConversationLinks('CONV-001').length).toBe(1)
  })

  it('unlinkConversation removes link', () => {
    svc.unlinkConversation('CONV-001', 'task', 'TASK-501')
    expect(svc.getConversationLinks('CONV-001').length).toBe(0)
  })

  it('addConversationAction + update to done', () => {
    const action = svc.addConversationAction({
      id: 'ACT-001',
      conversationId: 'CONV-001',
      assignee: 'DEV',
      description: 'Migrate sql.js → better-sqlite3'
    })
    expect(action.status).toBe('pending')

    const updated = svc.updateConversationAction('ACT-001', { status: 'done' })
    expect(updated.status).toBe('done')

    const all = svc.getConversationActions('CONV-001')
    expect(all.length).toBe(1)
    expect(all[0].assignee).toBe('DEV')
  })

  it('addConversationAction with linkedTaskId', () => {
    svc.addConversationAction({
      id: 'ACT-002',
      conversationId: 'CONV-001',
      assignee: 'DEV',
      description: 'Spawned task',
      linkedTaskId: 'TASK-501'
    })
    const action = svc.getConversationActions('CONV-001').find(a => a.id === 'ACT-002')!
    expect(action.linkedTaskId).toBe('TASK-501')
  })

  it('conversation_messages FK rejects unknown conversation', () => {
    expect(() => svc.addConversationMessage({
      conversationId: 'nonexistent-conv',
      authorName: 'X',
      content: 'orphan'
    })).toThrow()
  })

  it('conversation_actions FK rejects unknown conversation', () => {
    expect(() => svc.addConversationAction({
      conversationId: 'nonexistent-conv',
      assignee: 'X',
      description: 'orphan'
    })).toThrow()
  })

  it('deleteConversation cascades all related rows', () => {
    svc.createConversation({
      id: 'CONV-002',
      projectId: 'test-proj',
      title: 'throwaway',
      createdBy: 'X',
      participants: [{ name: 'X', type: 'human' }]
    })
    svc.addConversationMessage({ conversationId: 'CONV-002', authorName: 'X', content: 'hi' })
    svc.linkConversation('CONV-002', 'task', 'TASK-501')
    svc.addConversationAction({ conversationId: 'CONV-002', assignee: 'X', description: 'do thing' })

    svc.deleteConversation('CONV-002')
    expect(svc.getConversation('CONV-002')).toBeNull()
    expect(svc.getConversationMessages('CONV-002').length).toBe(0)
    expect(svc.getConversationLinks('CONV-002').length).toBe(0)
    expect(svc.getConversationActions('CONV-002').length).toBe(0)
    expect(svc.getConversationParticipants('CONV-002').length).toBe(0)
  })
})
