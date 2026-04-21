import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { SqliteTaskService } from './sqlite-task-service'
import { exportConversationMarkdown } from '../../adapters/mcp/mcp-tools/conversation-exporter'
import { buildProjectContext } from '../../adapters/mcp/mcp-tools/project-context-builder'
import { applyTaskUpdates, loadLastHandoff } from '../../adapters/mcp/mcp-tools/session-tools'
import { exportHandoffMarkdown } from '../../adapters/mcp/mcp-tools/session-handoff-exporter'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

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
    svc.createTask({
      id: 'TASK-SUB1',
      projectId: 'test-proj',
      title: 'Sub 1',
      parentTaskId: 'TASK-001'
    })
    svc.createTask({
      id: 'TASK-SUB2',
      projectId: 'test-proj',
      title: 'Sub 2',
      parentTaskId: 'TASK-001'
    })

    const subs = svc.getSubtasks('TASK-001')
    expect(subs.length).toBe(2)
    expect(subs.map((s) => s.id).sort()).toEqual(['TASK-SUB1', 'TASK-SUB2'])
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
    const phase = svc.createPhase({
      id: 'PH-A',
      projectId: 'test-proj',
      title: 'Phase A',
      position: 1
    })
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

  it('deletePhase removes the phase', () => {
    svc.deletePhase('PH-B')
    expect(svc.getPhase('PH-B')).toBeNull()
  })

  // ── Documents ──────────────────────────────────────────────────────────

  it('createDocument + getDocument', () => {
    const doc = svc.createDocument({
      id: 'ADR-001',
      projectId: 'test-proj',
      type: 'adr',
      title: 'Use SQLite'
    })
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
    expect(active.every((s) => s.status === 'active')).toBe(true)
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
    expect(active.find((s) => s.id === 'CTXSRC-001')).toBeUndefined()
  })

  it('context_sources FK rejects unknown project', () => {
    expect(() =>
      svc.createContextSource({
        projectId: 'nonexistent-proj',
        sourceType: 'file',
        sourcePath: 'x.md',
        label: 'x',
        category: 'what'
      })
    ).toThrow()
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
    expect(parts.find((p) => p.name === 'ARCH')?.role).toBe('requester')
    expect(parts.find((p) => p.name === 'DEV')?.type).toBe('role')
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
    const msg = svc.getConversationMessages('CONV-001').find((m) => m.id === 'MSG-003')!
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
    const action = svc.getConversationActions('CONV-001').find((a) => a.id === 'ACT-002')!
    expect(action.linkedTaskId).toBe('TASK-501')
  })

  it('conversation_messages FK rejects unknown conversation', () => {
    expect(() =>
      svc.addConversationMessage({
        conversationId: 'nonexistent-conv',
        authorName: 'X',
        content: 'orphan'
      })
    ).toThrow()
  })

  it('conversation_actions FK rejects unknown conversation', () => {
    expect(() =>
      svc.addConversationAction({
        conversationId: 'nonexistent-conv',
        assignee: 'X',
        description: 'orphan'
      })
    ).toThrow()
  })

  it('full conversation lifecycle: open → 3 msgs → decide with spawned task', () => {
    const conv = svc.createConversation({
      id: 'CONV-LC',
      projectId: 'test-proj',
      title: 'Remove outputData from execution response',
      createdBy: 'BE',
      participants: [
        { name: 'BE', type: 'role', role: 'requester' },
        { name: 'FE', type: 'role', role: 'reviewer' }
      ]
    })
    svc.linkConversation(conv.id, 'task', 'TASK-501')

    svc.addConversationMessage({
      conversationId: conv.id,
      authorName: 'BE',
      content: '3 options: A/B/C',
      messageType: 'proposal',
      metadata: {
        options: [
          { id: 'A', description: 'remove', tradeoff: 'breaking' },
          { id: 'B', description: 'slim', tradeoff: 'complex' },
          { id: 'C', description: 'keep', tradeoff: '50KB' }
        ]
      }
    })
    svc.addConversationMessage({
      conversationId: conv.id,
      authorName: 'FE',
      content: 'Pick A — lazy-load detail',
      messageType: 'review',
      metadata: { selectedOption: 'A' }
    })
    svc.addConversationMessage({
      conversationId: conv.id,
      authorName: 'BE',
      content: 'Acked, will implement',
      messageType: 'answer'
    })

    svc.updateConversation(conv.id, {
      status: 'decided',
      decisionSummary: 'Option A — FE lazy-load, BE set outputData NULL',
      decidedAt: new Date().toISOString()
    })

    const spawned = svc.createTask({
      id: 'TASK-SPAWN',
      projectId: 'test-proj',
      title: 'FE: remove Logs tab, lazy-load node detail',
      priority: 'high',
      labels: ['assignee:FE']
    })
    svc.addConversationAction({
      conversationId: conv.id,
      assignee: 'FE',
      description: 'Remove Logs tab, lazy-load node detail',
      linkedTaskId: spawned.id
    })
    svc.linkConversation(conv.id, 'task', spawned.id)

    const finalConv = svc.getConversation(conv.id)!
    expect(finalConv.status).toBe('decided')
    expect(finalConv.decisionSummary).toContain('Option A')

    const msgs = svc.getConversationMessages(conv.id)
    expect(msgs.length).toBe(3)
    expect(msgs[0].metadata?.options?.length).toBe(3)
    expect(msgs[1].metadata?.selectedOption).toBe('A')

    const actions = svc.getConversationActions(conv.id)
    expect(actions.length).toBe(1)
    expect(actions[0].linkedTaskId).toBe(spawned.id)

    const reverse = svc.findConversationsByLink('task', spawned.id)
    expect(reverse.map((c) => c.id)).toContain(conv.id)
  })

  it('exportConversationMarkdown writes conversation.md with decision + actions', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'choda-export-'))
    try {
      const conv = svc.createConversation({
        id: 'CONV-EXP',
        projectId: 'test-proj',
        title: 'Export smoke test',
        createdBy: 'ARCH',
        participants: [{ name: 'ARCH', type: 'role' }]
      })
      svc.addConversationMessage({
        conversationId: conv.id,
        authorName: 'ARCH',
        content: 'Proposing option A',
        messageType: 'proposal'
      })
      svc.updateConversation(conv.id, {
        status: 'decided',
        decisionSummary: 'Use option A',
        decidedAt: new Date().toISOString()
      })
      svc.addConversationAction({
        conversationId: conv.id,
        assignee: 'ARCH',
        description: 'Ship option A'
      })

      const filePath = exportConversationMarkdown(svc, conv.id, tmpRoot)
      expect(filePath).not.toBeNull()
      expect(fs.existsSync(filePath!)).toBe(true)

      const body = fs.readFileSync(filePath!, 'utf-8')
      expect(body).toContain('Export smoke test')
      expect(body).toContain('`DECIDED`')
      expect(body).toContain('**Decision:** Use option A')
      expect(body).toContain('- [ ] ARCH: Ship option A')
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it('exportConversationMarkdown returns null when contentRoot is empty', () => {
    const conv = svc.createConversation({
      id: 'CONV-NOROOT',
      projectId: 'test-proj',
      title: 'No root',
      createdBy: 'ARCH'
    })
    expect(exportConversationMarkdown(svc, conv.id, '')).toBeNull()
  })

  it('task_context-style query surfaces linked conversations + actions', () => {
    const task = svc.createTask({
      id: 'TASK-CTX',
      projectId: 'test-proj',
      title: 'Needs context'
    })
    const conv = svc.createConversation({
      id: 'CONV-CTX',
      projectId: 'test-proj',
      title: 'Decide approach for TASK-CTX',
      createdBy: 'ARCH',
      participants: [{ name: 'ARCH', type: 'role' }]
    })
    svc.linkConversation(conv.id, 'task', task.id)
    svc.updateConversation(conv.id, {
      status: 'decided',
      decisionSummary: 'Go with approach X'
    })
    svc.addConversationAction({
      conversationId: conv.id,
      assignee: 'ARCH',
      description: 'Implement X',
      linkedTaskId: task.id
    })

    const found = svc.findConversationsByLink('task', task.id)
    expect(found.map((c) => c.id)).toContain(conv.id)

    const actions = svc.getConversationActions(conv.id)
    expect(actions[0].linkedTaskId).toBe(task.id)
    expect(actions[0].description).toBe('Implement X')
  })

  it('project_context builder compiles WHO + WHAT + HOW + META', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'choda-ctx-'))
    try {
      const projectId = 'ctx-proj'
      const cwd = path.join(tmpRoot, '10-Projects', projectId)
      fs.mkdirSync(path.join(cwd, 'docs', 'decisions'), { recursive: true })
      fs.writeFileSync(path.join(cwd, 'context.md'), '# Overview\n\nProject does X.\n')
      fs.writeFileSync(path.join(cwd, 'docs', 'architecture.md'), '# Arch\n\nElectron + SQLite.\n')
      fs.writeFileSync(
        path.join(cwd, 'docs', 'decisions', 'ADR-001.md'),
        '# ADR-001\n\nChose SQLite.\n'
      )

      svc.ensureProject(projectId, projectId, cwd)

      svc.createContextSource({
        projectId,
        sourceType: 'file',
        sourcePath: `10-Projects/${projectId}/context.md`,
        label: 'System Overview',
        category: 'what',
        priority: 10
      })
      svc.createContextSource({
        projectId,
        sourceType: 'file',
        sourcePath: `10-Projects/${projectId}/docs/architecture.md`,
        label: 'Architecture',
        category: 'how',
        priority: 20
      })
      svc.createContextSource({
        projectId,
        sourceType: 'file',
        sourcePath: `10-Projects/${projectId}/docs/decisions/ADR-001.md`,
        label: 'ADR-001',
        category: 'decisions',
        priority: 30
      })

      const ph = svc.createPhase({
        id: 'PH-CTX',
        projectId,
        title: 'Phase X',
        startDate: '2026-04-01'
      })
      svc.createTask({ id: 'TASK-CTX-1', projectId, title: 'in flight', status: 'IN-PROGRESS' })
      svc.createSession({
        id: 'SESSION-CTX',
        projectId,
        status: 'completed',
        handoff: { resumePoint: 'TASK-CTX-1' }
      })
      svc.createConversation({
        id: 'CONV-CTX-OPEN',
        projectId,
        title: 'pending decision',
        createdBy: 'ARCH',
        participants: [{ name: 'ARCH', type: 'role' }]
      })

      const bundle = buildProjectContext(svc, projectId, 'full', tmpRoot)
      expect(bundle).not.toBeNull()
      expect(bundle!.project.id).toBe(projectId)
      expect(bundle!.currentState.activePhase?.id).toBe(ph.id)
      expect(bundle!.currentState.activeTasks.map((t) => t.id)).toContain('TASK-CTX-1')
      expect(bundle!.currentState.lastSession?.id).toBe('SESSION-CTX')
      expect(bundle!.currentState.openConversations.map((c) => c.id)).toContain('CONV-CTX-OPEN')
      expect(bundle!.architecture).toContain('Electron + SQLite')
      expect(bundle!.recentDecisions.length).toBe(1)
      expect(bundle!.contextSources.length).toBe(3)

      const summary = buildProjectContext(svc, projectId, 'summary', tmpRoot)
      expect(summary!.architecture!.length).toBeLessThanOrEqual(bundle!.architecture!.length)
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it('project_context returns null for unknown project', () => {
    expect(buildProjectContext(svc, 'nonexistent-proj', 'full', '/tmp')).toBeNull()
  })

  it('session lifecycle: start → end with tasks → round-trip sees handoff', () => {
    const projectId = 'sess-proj'
    svc.ensureProject(projectId, projectId, '/tmp/sess')
    const task = svc.createTask({
      id: 'TASK-SESS-1',
      projectId,
      title: 'work',
      status: 'IN-PROGRESS'
    })

    // session_start
    const first = svc.createSession({ projectId, status: 'active' })
    expect(loadLastHandoff(svc, projectId)).toBeNull() // no prior completed

    // session_end: tasks updated + handoff
    const updates = applyTaskUpdates(svc, [{ id: task.id, status: 'DONE' }])
    expect(updates).toEqual([
      {
        id: task.id,
        title: 'work',
        oldStatus: 'IN-PROGRESS',
        newStatus: 'DONE'
      }
    ])
    svc.updateSession(first.id, {
      status: 'completed',
      endedAt: new Date().toISOString(),
      handoff: {
        commits: ['abc123 — feat: something'],
        resumePoint: 'Write more tests',
        tasksUpdated: updates.map((u) => u.id)
      }
    })
    expect(svc.getTask(task.id)?.status).toBe('DONE')

    // next session_start sees previous handoff
    const last = loadLastHandoff(svc, projectId)
    expect(last?.sessionId).toBe(first.id)
    expect(last?.handoff.resumePoint).toBe('Write more tests')
  })

  it('N parallel active sessions per workspace (TASK-526)', () => {
    const projectId = 'parallel-proj'
    svc.ensureProject(projectId, projectId, '/tmp/parallel')
    const ws = 'workflow-engine'

    const s1 = svc.createSession({ projectId, workspaceId: ws, status: 'active' })
    const s2 = svc.createSession({ projectId, workspaceId: ws, status: 'active' })
    const s3 = svc.createSession({ projectId, workspaceId: ws, status: 'active' })

    expect(svc.getSession(s1.id)?.status).toBe('active')
    expect(svc.getSession(s2.id)?.status).toBe('active')
    expect(svc.getSession(s3.id)?.status).toBe('active')
  })

  it("rejects status='abandoned' (CHECK constraint)", () => {
    const projectId = 'check-proj'
    svc.ensureProject(projectId, projectId, '/tmp/check')
    expect(() =>
      svc.createSession({ projectId, status: 'abandoned' as never })
    ).toThrow(/CHECK constraint failed/i)
  })

  it('exportHandoffMarkdown writes formatted handoff.md', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'choda-handoff-'))
    try {
      const projectId = 'handoff-proj'
      svc.ensureProject(projectId, projectId, '/tmp/handoff')
      const session = svc.createSession({
        projectId,
        status: 'completed',
        handoff: {
          commits: ['abc123 — feat: X', 'def456 — fix: Y'],
          decisions: ['ADR-016 accepted'],
          resumePoint: 'Test SaleChannelNode with WireMock',
          looseEnds: ['stash@{0} unresolved'],
          tasksUpdated: ['TASK-158']
        }
      })
      svc.updateSession(session.id, { endedAt: new Date().toISOString() })

      const filePath = exportHandoffMarkdown(svc, session.id, tmpRoot)
      expect(filePath).not.toBeNull()
      const body = fs.readFileSync(filePath!, 'utf-8')
      expect(body).toContain(`session: ${session.id}`)
      expect(body).toContain(`project: ${projectId}`)
      expect(body).toContain('## What was done')
      expect(body).toContain('- abc123 — feat: X')
      expect(body).toContain('## Decisions made')
      expect(body).toContain('- ADR-016 accepted')
      expect(body).toContain('## Resume point\n\nTest SaleChannelNode with WireMock')
      expect(body).toContain('- stash@{0} unresolved')
      expect(body).toContain('- TASK-158')
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it('exportHandoffMarkdown returns null without contentRoot or unknown session', () => {
    expect(exportHandoffMarkdown(svc, 'SESSION-000', '')).toBeNull()
    expect(exportHandoffMarkdown(svc, 'nonexistent', '/tmp')).toBeNull()
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
    svc.addConversationAction({
      conversationId: 'CONV-002',
      assignee: 'X',
      description: 'do thing'
    })

    svc.deleteConversation('CONV-002')
    expect(svc.getConversation('CONV-002')).toBeNull()
    expect(svc.getConversationMessages('CONV-002').length).toBe(0)
    expect(svc.getConversationLinks('CONV-002').length).toBe(0)
    expect(svc.getConversationActions('CONV-002').length).toBe(0)
    expect(svc.getConversationParticipants('CONV-002').length).toBe(0)
  })
})
