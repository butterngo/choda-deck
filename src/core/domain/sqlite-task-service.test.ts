import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { SqliteTaskService } from './sqlite-task-service'
import { exportConversationMarkdown } from '../../adapters/mcp/mcp-tools/conversation-exporter'
import { buildProjectContext } from '../../adapters/mcp/mcp-tools/project-context-builder'
import { applyTaskUpdates, loadLastSession } from '../../adapters/mcp/mcp-tools/session-tools'
import { exportHandoffMarkdown } from '../../adapters/mcp/mcp-tools/session-handoff-exporter'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const TEST_DB = path.join(__dirname, '__test-tasks__.db')

describe('SqliteTaskService', () => {
  let svc: SqliteTaskService

  beforeAll(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
    svc = new SqliteTaskService(TEST_DB)
    await svc.ensureProject('test-proj', 'Test Project', '/tmp/test')
  })

  afterAll(async () => {
    await svc.close()
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  })

  // ── Task CRUD ──────────────────────────────────────────────────────────

  it('createTask + getTask', async () => {
    const task = await svc.createTask({
      id: 'TASK-001',
      projectId: 'test-proj',
      title: 'First task',
      priority: 'high'
    })
    expect(task.id).toBe('TASK-001')
    expect(task.status).toBe('TODO')
    expect(task.priority).toBe('high')

    const fetched = await svc.getTask('TASK-001')
    expect(fetched).not.toBeNull()
    expect(fetched!.title).toBe('First task')
  })

  it('getTask returns null for missing', async () => {
    expect(await svc.getTask('TASK-999')).toBeNull()
  })

  it('updateTask changes fields', async () => {
    const updated = await svc.updateTask('TASK-001', {
      status: 'IN-PROGRESS',
      priority: 'critical',
      labels: ['urgent', 'bug']
    })
    expect(updated.status).toBe('IN-PROGRESS')
    expect(updated.priority).toBe('critical')
    expect(updated.labels).toEqual(['urgent', 'bug'])
    expect(updated.title).toBe('First task')
  })

  it('updateTask throws for missing', async () => {
    await expect(svc.updateTask('TASK-999', { title: 'x' })).rejects.toThrow('not found')
  })

  it('findTasks filters correctly', async () => {
    await svc.createTask({ id: 'TASK-002', projectId: 'test-proj', title: 'Second task', status: 'TODO' })
    await svc.createTask({ id: 'TASK-003', projectId: 'test-proj', title: 'Third task', status: 'DONE' })

    const inProgress = await svc.findTasks({ projectId: 'test-proj', status: 'IN-PROGRESS' })
    expect(inProgress.length).toBe(1)
    expect(inProgress[0].id).toBe('TASK-001')

    const all = await svc.findTasks({ projectId: 'test-proj' })
    expect(all.length).toBe(3)

    const search = await svc.findTasks({ query: 'Second' })
    expect(search.length).toBe(1)
    expect(search[0].id).toBe('TASK-002')

    const limited = await svc.findTasks({ projectId: 'test-proj', limit: 2 })
    expect(limited.length).toBe(2)
  })

  it('CANCELLED status round-trips through SQLite', async () => {
    const created = await svc.createTask({
      id: 'TASK-CANCELLED-1',
      projectId: 'test-proj',
      title: 'Cancelled task',
      status: 'CANCELLED'
    })
    expect(created.status).toBe('CANCELLED')

    const fetched = await svc.getTask('TASK-CANCELLED-1')
    expect(fetched!.status).toBe('CANCELLED')

    const filtered = await svc.findTasks({ projectId: 'test-proj', status: 'CANCELLED' })
    expect(filtered.map((t) => t.id)).toContain('TASK-CANCELLED-1')

    const updated = await svc.updateTask('TASK-CANCELLED-1', { status: 'TODO' })
    expect(updated.status).toBe('TODO')
  })

  it('getDueTasks excludes CANCELLED tasks', async () => {
    await svc.createTask({
      id: 'TASK-DUE-CANCELLED',
      projectId: 'test-proj',
      title: 'Overdue but cancelled',
      status: 'CANCELLED',
      dueDate: '2020-01-01'
    })
    const due = await svc.getDueTasks('2030-01-01')
    expect(due.find((t) => t.id === 'TASK-DUE-CANCELLED')).toBeUndefined()
  })

  it('findTasks filters by labels (OR semantics)', async () => {
    await svc.createTask({
      id: 'TASK-LBL-A',
      projectId: 'test-proj',
      title: 'Labeled A',
      labels: ['mcp', 'dx']
    })
    await svc.createTask({
      id: 'TASK-LBL-B',
      projectId: 'test-proj',
      title: 'Labeled B',
      labels: ['ui']
    })
    await svc.createTask({
      id: 'TASK-LBL-C',
      projectId: 'test-proj',
      title: 'Labeled C',
      labels: ['mcp']
    })

    const mcp = await svc.findTasks({ projectId: 'test-proj', labels: ['mcp'] })
    expect(mcp.map((t) => t.id).sort()).toEqual(['TASK-LBL-A', 'TASK-LBL-C'])

    const mcpOrUi = await svc.findTasks({ projectId: 'test-proj', labels: ['mcp', 'ui'] })
    expect(mcpOrUi.map((t) => t.id).sort()).toEqual(['TASK-LBL-A', 'TASK-LBL-B', 'TASK-LBL-C'])

    const none = await svc.findTasks({ projectId: 'test-proj', labels: ['no-such-label'] })
    expect(none.length).toBe(0)

    const empty = await svc.findTasks({ projectId: 'test-proj', labels: [] })
    expect(empty.length).toBeGreaterThanOrEqual(3)

    const mcpDone = await svc.findTasks({ projectId: 'test-proj', labels: ['mcp'], status: 'DONE' })
    expect(mcpDone.length).toBe(0)

    // substring boundary: "mcp" label should not match "mcp-extra"
    await svc.createTask({
      id: 'TASK-LBL-D',
      projectId: 'test-proj',
      title: 'Labeled D',
      labels: ['mcp-extra']
    })
    const exact = await svc.findTasks({ projectId: 'test-proj', labels: ['mcp'] })
    expect(exact.map((t) => t.id).sort()).toEqual(['TASK-LBL-A', 'TASK-LBL-C'])
  })

  it('deleteTask removes task + cascades deps', async () => {
    await svc.createTask({ id: 'TASK-DEL', projectId: 'test-proj', title: 'To delete' })
    await svc.addDependency('TASK-001', 'TASK-DEL')

    await svc.deleteTask('TASK-DEL')
    expect(await svc.getTask('TASK-DEL')).toBeNull()
    expect((await svc.getDependencies('TASK-001')).length).toBe(0)
  })

  // ── Subtasks ───────────────────────────────────────────────────────────

  it('subtasks via parentTaskId', async () => {
    await svc.createTask({
      id: 'TASK-SUB1',
      projectId: 'test-proj',
      title: 'Sub 1',
      parentTaskId: 'TASK-001'
    })
    await svc.createTask({
      id: 'TASK-SUB2',
      projectId: 'test-proj',
      title: 'Sub 2',
      parentTaskId: 'TASK-001'
    })

    const subs = await svc.getSubtasks('TASK-001')
    expect(subs.length).toBe(2)
    expect(subs.map((s) => s.id).sort()).toEqual(['TASK-SUB1', 'TASK-SUB2'])
  })

  // ── Dependencies ───────────────────────────────────────────────────────

  it('addDependency + getDependencies', async () => {
    await svc.addDependency('TASK-001', 'TASK-002')
    await svc.addDependency('TASK-001', 'TASK-003')

    const deps = await svc.getDependencies('TASK-001')
    expect(deps.length).toBe(2)
  })

  it('addDependency is idempotent', async () => {
    await svc.addDependency('TASK-001', 'TASK-002')
    const deps = await svc.getDependencies('TASK-001')
    expect(deps.length).toBe(2)
  })

  it('removeDependency', async () => {
    await svc.removeDependency('TASK-001', 'TASK-002')
    const deps = await svc.getDependencies('TASK-001')
    expect(deps.length).toBe(1)
  })

  // ── Daily focus ────────────────────────────────────────────────────────

  it('pinned tasks', async () => {
    await svc.updateTask('TASK-001', { pinned: true })
    const pinned = await svc.getPinnedTasks()
    expect(pinned.length).toBe(1)
    expect(pinned[0].id).toBe('TASK-001')
  })

  it('due tasks', async () => {
    await svc.updateTask('TASK-002', { dueDate: '2026-04-13' })
    const due = await svc.getDueTasks('2026-04-13')
    expect(due.length).toBe(1)
    expect(due[0].id).toBe('TASK-002')
  })

  // ── Documents ──────────────────────────────────────────────────────────

  it('createDocument + getDocument', async () => {
    const doc = await svc.createDocument({
      id: 'ADR-001',
      projectId: 'test-proj',
      type: 'adr',
      title: 'Use SQLite'
    })
    expect(doc.id).toBe('ADR-001')
    expect(doc.type).toBe('adr')
  })

  it('findDocuments by type', async () => {
    await svc.createDocument({ id: 'SPEC-001', projectId: 'test-proj', type: 'spec', title: 'API spec' })
    const adrs = await svc.findDocuments('test-proj', 'adr')
    expect(adrs.length).toBe(1)
    const all = await svc.findDocuments('test-proj')
    expect(all.length).toBe(2)
  })

  it('deleteDocument removes tags', async () => {
    await svc.addTag('ADR-001', 'sqlite')
    await svc.deleteDocument('ADR-001')
    expect(await svc.getDocument('ADR-001')).toBeNull()
    expect(await svc.getTags('ADR-001')).toEqual([])
  })

  // ── Tags ──────────────────────────────────────────────────────────────

  it('addTag + getTags', async () => {
    await svc.addTag('TASK-001', 'electron')
    await svc.addTag('TASK-001', 'react')
    const tags = await svc.getTags('TASK-001')
    expect(tags).toEqual(['electron', 'react'])
  })

  it('addTag is idempotent', async () => {
    await svc.addTag('TASK-001', 'electron')
    expect((await svc.getTags('TASK-001')).length).toBe(2)
  })

  it('removeTag', async () => {
    await svc.removeTag('TASK-001', 'react')
    expect(await svc.getTags('TASK-001')).toEqual(['electron'])
  })

  it('findByTag', async () => {
    await svc.addTag('TASK-002', 'electron')
    const items = await svc.findByTag('electron')
    expect(items).toContain('TASK-001')
    expect(items).toContain('TASK-002')
  })

  // ── Relationships ─────────────────────────────────────────────────────

  it('addRelationship + getRelationships', async () => {
    await svc.addRelationship('TASK-001', 'FEAT-001', 'IMPLEMENTS')
    await svc.addRelationship('TASK-001', 'TASK-002', 'DEPENDS_ON')
    const rels = await svc.getRelationships('TASK-001')
    // TASK-001 has: DEPENDS_ON TASK-003 (from earlier dep tests) + IMPLEMENTS FEAT-001 + DEPENDS_ON TASK-002
    expect(rels.length).toBe(3)
  })

  it('addRelationship is idempotent', async () => {
    await svc.addRelationship('TASK-001', 'FEAT-001', 'IMPLEMENTS')
    expect((await svc.getRelationships('TASK-001')).length).toBe(3)
  })

  it('getRelationshipsFrom with type filter', async () => {
    const deps = await svc.getRelationshipsFrom('TASK-001', 'DEPENDS_ON')
    expect(deps.length).toBe(2) // TASK-002 + TASK-003
  })

  it('removeRelationship', async () => {
    await svc.removeRelationship('TASK-001', 'TASK-002', 'DEPENDS_ON')
    await svc.removeRelationship('TASK-001', 'TASK-003', 'DEPENDS_ON')
    const rels = await svc.getRelationshipsFrom('TASK-001', 'DEPENDS_ON')
    expect(rels.length).toBe(0)
  })

  // ── Sessions (M1) ──────────────────────────────────────────────────────

  it('createSession + getSession', async () => {
    const s = await svc.createSession({
      id: 'SESSION-001',
      projectId: 'test-proj',
      handoff: { commits: ['abc123'], resumePoint: 'TASK-501' }
    })
    expect(s.id).toBe('SESSION-001')
    expect(s.status).toBe('active')
    expect(s.handoff?.resumePoint).toBe('TASK-501')

    const fetched = await svc.getSession('SESSION-001')
    expect(fetched?.handoff?.commits).toEqual(['abc123'])
  })

  it('getActiveSession returns latest active', async () => {
    await svc.createSession({ id: 'SESSION-002', projectId: 'test-proj' })
    const active = await svc.getActiveSession('test-proj')
    expect(active).not.toBeNull()
    expect(['SESSION-001', 'SESSION-002']).toContain(active!.id)
  })

  it('updateSession marks completed', async () => {
    const updated = await svc.updateSession('SESSION-001', {
      status: 'completed',
      endedAt: new Date().toISOString(),
      handoff: { decisions: ['chose better-sqlite3'] }
    })
    expect(updated.status).toBe('completed')
    expect(updated.endedAt).not.toBeNull()
    expect(updated.handoff?.decisions).toEqual(['chose better-sqlite3'])
  })

  it('findSessions filters by status', async () => {
    const active = await svc.findSessions('test-proj', 'active')
    expect(active.every((s) => s.status === 'active')).toBe(true)
    const all = await svc.findSessions('test-proj')
    expect(all.length).toBeGreaterThanOrEqual(active.length)
  })

  it('sessions FK rejects unknown project', async () => {
    await expect(svc.createSession({ projectId: 'nonexistent-proj' })).rejects.toThrow()
  })

  // ── ContextSources (M1) ────────────────────────────────────────────────

  it('createContextSource + getContextSource', async () => {
    const src = await svc.createContextSource({
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
    expect((await svc.getContextSource('CTXSRC-001'))?.label).toBe('System Architecture')
  })

  it('findContextSources orders by priority', async () => {
    await svc.createContextSource({
      id: 'CTXSRC-002',
      projectId: 'test-proj',
      sourceType: 'file',
      sourcePath: 'CLAUDE.md',
      label: 'Project Conventions',
      category: 'how',
      priority: 5
    })
    const sources = await svc.findContextSources('test-proj')
    expect(sources[0].id).toBe('CTXSRC-002')
    expect(sources[1].id).toBe('CTXSRC-001')
  })

  it('updateContextSource toggles is_active', async () => {
    const updated = await svc.updateContextSource('CTXSRC-001', { isActive: false })
    expect(updated.isActive).toBe(false)
    const active = await svc.findContextSources('test-proj', true)
    expect(active.find((s) => s.id === 'CTXSRC-001')).toBeUndefined()
  })

  it('context_sources FK rejects unknown project', async () => {
    await expect(svc.createContextSource({
        projectId: 'nonexistent-proj',
        sourceType: 'file',
        sourcePath: 'x.md',
        label: 'x',
        category: 'what'
      })).rejects.toThrow()
  })

  // ── Conversations (M1 / TASK-504) ──────────────────────────────────────

  it('createConversation + getConversation + participants', async () => {
    const c = await svc.createConversation({
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

    const parts = await svc.getConversationParticipants('CONV-001')
    expect(parts.length).toBe(2)
    expect(parts.find((p) => p.name === 'ARCH')?.role).toBe('requester')
    expect(parts.find((p) => p.name === 'DEV')?.type).toBe('role')
  })

  it('addConversationMessage + getConversationMessages ordered', async () => {
    await svc.addConversationMessage({
      id: 'MSG-001',
      conversationId: 'CONV-001',
      authorName: 'ARCH',
      content: 'Should we use sql.js or better-sqlite3?',
      messageType: 'question'
    })
    await svc.addConversationMessage({
      id: 'MSG-002',
      conversationId: 'CONV-001',
      authorName: 'DEV',
      content: 'better-sqlite3 — sync API, no WASM',
      messageType: 'answer'
    })
    const msgs = await svc.getConversationMessages('CONV-001')
    expect(msgs.length).toBe(2)
    expect(msgs[0].id).toBe('MSG-001')
    expect(msgs[0].authorName).toBe('ARCH')
    expect(msgs[1].messageType).toBe('answer')
  })

  it('addConversationMessage with metadata persists JSON', async () => {
    await svc.addConversationMessage({
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
    const msg = (await svc.getConversationMessages('CONV-001')).find((m) => m.id === 'MSG-003')!
    expect(msg.metadata?.options?.length).toBe(2)
    expect(msg.metadata?.options?.[0].id).toBe('A')
  })

  it('updateConversation records decision', async () => {
    const decidedAt = new Date().toISOString()
    const updated = await svc.updateConversation('CONV-001', {
      status: 'decided',
      decisionSummary: 'Use better-sqlite3',
      decidedAt
    })
    expect(updated.status).toBe('decided')
    expect(updated.decisionSummary).toBe('Use better-sqlite3')
    expect(updated.decidedAt).toBe(decidedAt)
  })

  it('linkConversation + findConversationsByLink', async () => {
    await svc.linkConversation('CONV-001', 'task', 'TASK-501')
    const links = await svc.getConversationLinks('CONV-001')
    expect(links.length).toBe(1)
    expect(links[0].linkedId).toBe('TASK-501')

    const convs = await svc.findConversationsByLink('task', 'TASK-501')
    expect(convs.length).toBe(1)
    expect(convs[0].id).toBe('CONV-001')
  })

  it('linkConversation is idempotent', async () => {
    await svc.linkConversation('CONV-001', 'task', 'TASK-501')
    expect((await svc.getConversationLinks('CONV-001')).length).toBe(1)
  })

  it('unlinkConversation removes link', async () => {
    await svc.unlinkConversation('CONV-001', 'task', 'TASK-501')
    expect((await svc.getConversationLinks('CONV-001')).length).toBe(0)
  })

  it('addConversationAction + update to done', async () => {
    const action = await svc.addConversationAction({
      id: 'ACT-001',
      conversationId: 'CONV-001',
      assignee: 'DEV',
      description: 'Migrate sql.js → better-sqlite3'
    })
    expect(action.status).toBe('pending')

    const updated = await svc.updateConversationAction('ACT-001', { status: 'done' })
    expect(updated.status).toBe('done')

    const all = await svc.getConversationActions('CONV-001')
    expect(all.length).toBe(1)
    expect(all[0].assignee).toBe('DEV')
  })

  it('addConversationAction with linkedTaskId', async () => {
    await svc.addConversationAction({
      id: 'ACT-002',
      conversationId: 'CONV-001',
      assignee: 'DEV',
      description: 'Spawned task',
      linkedTaskId: 'TASK-501'
    })
    const action = (await svc.getConversationActions('CONV-001')).find((a) => a.id === 'ACT-002')!
    expect(action.linkedTaskId).toBe('TASK-501')
  })

  it('conversation_messages FK rejects unknown conversation', async () => {
    await expect(svc.addConversationMessage({
        conversationId: 'nonexistent-conv',
        authorName: 'X',
        content: 'orphan'
      })).rejects.toThrow()
  })

  it('conversation_actions FK rejects unknown conversation', async () => {
    await expect(svc.addConversationAction({
        conversationId: 'nonexistent-conv',
        assignee: 'X',
        description: 'orphan'
      })).rejects.toThrow()
  })

  it('full conversation lifecycle: open → 3 msgs → decide with spawned task', async () => {
    const conv = await svc.createConversation({
      id: 'CONV-LC',
      projectId: 'test-proj',
      title: 'Remove outputData from execution response',
      createdBy: 'BE',
      participants: [
        { name: 'BE', type: 'role', role: 'requester' },
        { name: 'FE', type: 'role', role: 'reviewer' }
      ]
    })
    await svc.linkConversation(conv.id, 'task', 'TASK-501')

    await svc.addConversationMessage({
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
    await svc.addConversationMessage({
      conversationId: conv.id,
      authorName: 'FE',
      content: 'Pick A — lazy-load detail',
      messageType: 'review',
      metadata: { selectedOption: 'A' }
    })
    await svc.addConversationMessage({
      conversationId: conv.id,
      authorName: 'BE',
      content: 'Acked, will implement',
      messageType: 'answer'
    })

    await svc.updateConversation(conv.id, {
      status: 'decided',
      decisionSummary: 'Option A — FE lazy-load, BE set outputData NULL',
      decidedAt: new Date().toISOString()
    })

    const spawned = await svc.createTask({
      id: 'TASK-SPAWN',
      projectId: 'test-proj',
      title: 'FE: remove Logs tab, lazy-load node detail',
      priority: 'high',
      labels: ['assignee:FE']
    })
    await svc.addConversationAction({
      conversationId: conv.id,
      assignee: 'FE',
      description: 'Remove Logs tab, lazy-load node detail',
      linkedTaskId: spawned.id
    })
    await svc.linkConversation(conv.id, 'task', spawned.id)

    const finalConv = await svc.getConversation(conv.id)!
    expect(finalConv.status).toBe('decided')
    expect(finalConv.decisionSummary).toContain('Option A')

    const msgs = await svc.getConversationMessages(conv.id)
    expect(msgs.length).toBe(3)
    expect(msgs[0].metadata?.options?.length).toBe(3)
    expect(msgs[1].metadata?.selectedOption).toBe('A')

    const actions = await svc.getConversationActions(conv.id)
    expect(actions.length).toBe(1)
    expect(actions[0].linkedTaskId).toBe(spawned.id)

    const reverse = await svc.findConversationsByLink('task', spawned.id)
    expect(reverse.map((c) => c.id)).toContain(conv.id)
  })

  it('exportConversationMarkdown writes conversation.md with decision + actions', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'choda-export-'))
    try {
      const conv = await svc.createConversation({
        id: 'CONV-EXP',
        projectId: 'test-proj',
        title: 'Export smoke test',
        createdBy: 'ARCH',
        participants: [{ name: 'ARCH', type: 'role' }]
      })
      await svc.addConversationMessage({
        conversationId: conv.id,
        authorName: 'ARCH',
        content: 'Proposing option A',
        messageType: 'proposal'
      })
      await svc.updateConversation(conv.id, {
        status: 'decided',
        decisionSummary: 'Use option A',
        decidedAt: new Date().toISOString()
      })
      await svc.addConversationAction({
        conversationId: conv.id,
        assignee: 'ARCH',
        description: 'Ship option A'
      })

      const filePath = await exportConversationMarkdown(svc, conv.id, tmpRoot)
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

  it('exportConversationMarkdown returns null when contentRoot is empty', async () => {
    const conv = await svc.createConversation({
      id: 'CONV-NOROOT',
      projectId: 'test-proj',
      title: 'No root',
      createdBy: 'ARCH'
    })
    expect(await exportConversationMarkdown(svc, conv.id, '')).toBeNull()
  })

  it('task_context-style query surfaces linked conversations + actions', async () => {
    const task = await svc.createTask({
      id: 'TASK-CTX',
      projectId: 'test-proj',
      title: 'Needs context'
    })
    const conv = await svc.createConversation({
      id: 'CONV-CTX',
      projectId: 'test-proj',
      title: 'Decide approach for TASK-CTX',
      createdBy: 'ARCH',
      participants: [{ name: 'ARCH', type: 'role' }]
    })
    await svc.linkConversation(conv.id, 'task', task.id)
    await svc.updateConversation(conv.id, {
      status: 'decided',
      decisionSummary: 'Go with approach X'
    })
    await svc.addConversationAction({
      conversationId: conv.id,
      assignee: 'ARCH',
      description: 'Implement X',
      linkedTaskId: task.id
    })

    const found = await svc.findConversationsByLink('task', task.id)
    expect(found.map((c) => c.id)).toContain(conv.id)

    const actions = await svc.getConversationActions(conv.id)
    expect(actions[0].linkedTaskId).toBe(task.id)
    expect(actions[0].description).toBe('Implement X')
  })

  it('project_context builder compiles WHO + WHAT + HOW + META', async () => {
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

      await svc.ensureProject(projectId, projectId, cwd)

      await svc.createContextSource({
        projectId,
        sourceType: 'file',
        sourcePath: `10-Projects/${projectId}/context.md`,
        label: 'System Overview',
        category: 'what',
        priority: 10
      })
      await svc.createContextSource({
        projectId,
        sourceType: 'file',
        sourcePath: `10-Projects/${projectId}/docs/architecture.md`,
        label: 'Architecture',
        category: 'how',
        priority: 20
      })
      await svc.createContextSource({
        projectId,
        sourceType: 'file',
        sourcePath: `10-Projects/${projectId}/docs/decisions/ADR-001.md`,
        label: 'ADR-001',
        category: 'decisions',
        priority: 30
      })

      await svc.createTask({ id: 'TASK-CTX-1', projectId, title: 'in flight', status: 'IN-PROGRESS' })
      await svc.createSession({
        id: 'SESSION-CTX',
        projectId,
        status: 'completed',
        handoff: { resumePoint: 'TASK-CTX-1' }
      })
      await svc.createConversation({
        id: 'CONV-CTX-OPEN',
        projectId,
        title: 'pending decision',
        createdBy: 'ARCH',
        participants: [{ name: 'ARCH', type: 'role' }]
      })

      const bundle = await buildProjectContext(svc, projectId, 'full', tmpRoot)
      expect(bundle).not.toBeNull()
      expect(bundle!.project.id).toBe(projectId)
      expect(bundle!.currentState.activeTasks.map((t) => t.id)).toContain('TASK-CTX-1')
      expect(bundle!.currentState.lastSession?.id).toBe('SESSION-CTX')
      expect(bundle!.currentState.openConversations.map((c) => c.id)).toContain('CONV-CTX-OPEN')
      expect(bundle!.architecture).toContain('Electron + SQLite')
      expect(bundle!.recentDecisions.length).toBe(1)
      expect(bundle!.contextSources.length).toBe(3)

      const summary = await buildProjectContext(svc, projectId, 'summary', tmpRoot)
      expect(summary!.architecture!.length).toBeLessThanOrEqual(bundle!.architecture!.length)
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it('project_context returns null for unknown project', async () => {
    expect(await buildProjectContext(svc, 'nonexistent-proj', 'full', '/tmp')).toBeNull()
  })

  it('session lifecycle: start → end with tasks → round-trip sees handoff', async () => {
    const projectId = 'sess-proj'
    await svc.ensureProject(projectId, projectId, '/tmp/sess')
    const task = await svc.createTask({
      id: 'TASK-SESS-1',
      projectId,
      title: 'work',
      status: 'IN-PROGRESS'
    })

    // session_start
    const first = await svc.createSession({ projectId, status: 'active' })
    expect(await loadLastSession(svc, projectId)).toBeNull() // no prior completed

    // session_end: tasks updated + handoff
    const updates = await applyTaskUpdates(svc, [{ id: task.id, status: 'DONE' }])
    expect(updates).toEqual([
      {
        id: task.id,
        title: 'work',
        oldStatus: 'IN-PROGRESS',
        newStatus: 'DONE'
      }
    ])
    await svc.updateSession(first.id, {
      status: 'completed',
      endedAt: new Date().toISOString(),
      handoff: {
        commits: ['abc123 — feat: something'],
        resumePoint: 'Write more tests',
        tasksUpdated: updates.map((u) => u.id)
      }
    })
    expect((await svc.getTask(task.id))?.status).toBe('DONE')

    // next session_start sees previous handoff
    const last = await loadLastSession(svc, projectId)
    expect(last?.id).toBe(first.id)
    expect(last?.resumePoint).toBe('Write more tests')
  })

  it('N parallel active sessions per workspace (TASK-526)', async () => {
    const projectId = 'parallel-proj'
    await svc.ensureProject(projectId, projectId, '/tmp/parallel')
    const ws = 'workflow-engine'

    const s1 = await svc.createSession({ projectId, workspaceId: ws, status: 'active' })
    const s2 = await svc.createSession({ projectId, workspaceId: ws, status: 'active' })
    const s3 = await svc.createSession({ projectId, workspaceId: ws, status: 'active' })

    expect((await svc.getSession(s1.id))?.status).toBe('active')
    expect((await svc.getSession(s2.id))?.status).toBe('active')
    expect((await svc.getSession(s3.id))?.status).toBe('active')
  })

  it("rejects status='abandoned' (CHECK constraint)", async () => {
    const projectId = 'check-proj'
    await svc.ensureProject(projectId, projectId, '/tmp/check')
    await expect(svc.createSession({ projectId, status: 'abandoned' as never })).rejects.toThrow(/CHECK constraint failed/i)
  })

  it('exportHandoffMarkdown writes formatted handoff.md', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'choda-handoff-'))
    try {
      const projectId = 'handoff-proj'
      await svc.ensureProject(projectId, projectId, '/tmp/handoff')
      const session = await svc.createSession({
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
      await svc.updateSession(session.id, { endedAt: new Date().toISOString() })

      const filePath = await exportHandoffMarkdown(svc, session.id, tmpRoot)
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

  it('exportHandoffMarkdown returns null without contentRoot or unknown session', async () => {
    expect(await exportHandoffMarkdown(svc, 'SESSION-000', '')).toBeNull()
    expect(await exportHandoffMarkdown(svc, 'nonexistent', '/tmp')).toBeNull()
  })

  it('exportHandoffMarkdown renders Test results section with passed + skipped', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'choda-handoff-tr-'))
    try {
      const projectId = 'tr-proj'
      await svc.ensureProject(projectId, projectId, '/tmp/tr')
      const session = await svc.createSession({
        projectId,
        status: 'completed',
        handoff: {
          resumePoint: 'verify',
          testResults: {
            passed: ['unit: task_create default body', 'manual: session_end persists testResults'],
            skipped: ['IE11 check — no VM']
          }
        }
      })
      await svc.updateSession(session.id, { endedAt: new Date().toISOString() })

      const filePath = await exportHandoffMarkdown(svc, session.id, tmpRoot)
      const body = fs.readFileSync(filePath!, 'utf-8')
      expect(body).toContain('## Test results')
      expect(body).toContain('### Passed')
      expect(body).toContain('- unit: task_create default body')
      expect(body).toContain('### Skipped')
      expect(body).toContain('- IE11 check — no VM')
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it('exportHandoffMarkdown shows _none_ when no testResults', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'choda-handoff-tr-none-'))
    try {
      const projectId = 'tr-none-proj'
      await svc.ensureProject(projectId, projectId, '/tmp/tr-none')
      const session = await svc.createSession({
        projectId,
        status: 'completed',
        handoff: { resumePoint: 'no test meta' }
      })
      await svc.updateSession(session.id, { endedAt: new Date().toISOString() })

      const filePath = await exportHandoffMarkdown(svc, session.id, tmpRoot)
      const body = fs.readFileSync(filePath!, 'utf-8')
      expect(body).toContain('## Test results\n\n_none_')
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it('deleteConversation cascades all related rows', async () => {
    await svc.createConversation({
      id: 'CONV-002',
      projectId: 'test-proj',
      title: 'throwaway',
      createdBy: 'X',
      participants: [{ name: 'X', type: 'human' }]
    })
    await svc.addConversationMessage({ conversationId: 'CONV-002', authorName: 'X', content: 'hi' })
    await svc.linkConversation('CONV-002', 'task', 'TASK-501')
    await svc.addConversationAction({
      conversationId: 'CONV-002',
      assignee: 'X',
      description: 'do thing'
    })

    await svc.deleteConversation('CONV-002')
    expect(await svc.getConversation('CONV-002')).toBeNull()
    expect((await svc.getConversationMessages('CONV-002')).length).toBe(0)
    expect((await svc.getConversationLinks('CONV-002')).length).toBe(0)
    expect((await svc.getConversationActions('CONV-002')).length).toBe(0)
    expect((await svc.getConversationParticipants('CONV-002')).length).toBe(0)
  })
})
