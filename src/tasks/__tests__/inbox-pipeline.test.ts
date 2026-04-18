import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { SqliteTaskService } from '../sqlite-task-service'
import * as fs from 'fs'
import * as path from 'path'

const TEST_DB = path.join(__dirname, '__test-inbox__.db')
let svc: SqliteTaskService

beforeAll(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  svc = new SqliteTaskService(TEST_DB)
  svc.ensureProject('proj-i', 'Inbox Project', '/tmp/i')
})

afterAll(() => {
  svc.close()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
})

describe('inbox: id + counter', () => {
  it('auto-increments globally — INBOX-001, INBOX-002', () => {
    const a = svc.createInbox({ projectId: 'proj-i', content: 'first idea' })
    const b = svc.createInbox({ projectId: 'proj-i', content: 'second idea' })
    expect(a.id).toBe('INBOX-001')
    expect(b.id).toBe('INBOX-002')
    expect(a.status).toBe('raw')
  })
})

describe('inbox: find + filter', () => {
  it('finds by projectId', () => {
    const rows = svc.findInbox({ projectId: 'proj-i' })
    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(rows.every((r) => r.projectId === 'proj-i')).toBe(true)
  })

  it('filters by status', () => {
    const raw = svc.findInbox({ projectId: 'proj-i', status: 'raw' })
    expect(raw.every((r) => r.status === 'raw')).toBe(true)
  })
})

describe('inbox: state machine', () => {
  it('raw → researching opens linked conversation', () => {
    const item = svc.createInbox({ projectId: 'proj-i', content: 'needs research' })
    const conv = svc.createConversation({
      projectId: 'proj-i',
      title: `Research: ${item.content}`,
      createdBy: 'Claude',
      status: 'open',
      participants: [{ name: 'Claude', type: 'agent' as const }]
    })
    svc.linkConversation(conv.id, 'inbox', item.id)
    const updated = svc.updateInbox(item.id, { status: 'researching' })
    expect(updated.status).toBe('researching')

    const linked = svc.findConversationsByLink('inbox', item.id)
    expect(linked.length).toBe(1)
    expect(linked[0].id).toBe(conv.id)
  })

  it('researching → ready', () => {
    const item = svc.createInbox({ projectId: 'proj-i', content: 'r2' })
    svc.updateInbox(item.id, { status: 'researching' })
    const ready = svc.updateInbox(item.id, { status: 'ready' })
    expect(ready.status).toBe('ready')
  })

  it('ready → converted sets linked_task_id + closes conversation', () => {
    const item = svc.createInbox({ projectId: 'proj-i', content: 'to convert' })
    const conv = svc.createConversation({
      projectId: 'proj-i',
      title: `Research: ${item.content}`,
      createdBy: 'Claude',
      status: 'open',
      participants: [{ name: 'Claude', type: 'agent' as const }]
    })
    svc.linkConversation(conv.id, 'inbox', item.id)
    svc.updateInbox(item.id, { status: 'researching' })
    svc.updateInbox(item.id, { status: 'ready' })

    const task = svc.createTask({
      projectId: 'proj-i',
      title: 'Converted task',
      status: 'TODO'
    })
    svc.updateInbox(item.id, { status: 'converted', linkedTaskId: task.id })
    svc.updateConversation(conv.id, {
      status: 'closed',
      decisionSummary: `Converted to ${task.id}`,
      closedAt: new Date().toISOString()
    })

    const final = svc.getInbox(item.id)!
    expect(final.status).toBe('converted')
    expect(final.linkedTaskId).toBe(task.id)

    const closedConv = svc.getConversation(conv.id)!
    expect(closedConv.status).toBe('closed')
    expect(closedConv.decisionSummary).toContain(task.id)
  })

  it('archive closes linked conversation', () => {
    const item = svc.createInbox({ projectId: 'proj-i', content: 'reject' })
    const conv = svc.createConversation({
      projectId: 'proj-i',
      title: `Research: ${item.content}`,
      createdBy: 'Claude',
      status: 'open',
      participants: [{ name: 'Claude', type: 'agent' as const }]
    })
    svc.linkConversation(conv.id, 'inbox', item.id)
    svc.updateInbox(item.id, { status: 'archived' })
    svc.updateConversation(conv.id, {
      status: 'closed',
      decisionSummary: 'Archived',
      closedAt: new Date().toISOString()
    })

    expect(svc.getInbox(item.id)!.status).toBe('archived')
    expect(svc.getConversation(conv.id)!.status).toBe('closed')
  })
})

describe('inbox: delete', () => {
  it('deletes raw item', () => {
    const item = svc.createInbox({ projectId: 'proj-i', content: 'to delete' })
    expect(item.status).toBe('raw')
    svc.deleteInbox(item.id)
    expect(svc.getInbox(item.id)).toBeNull()
  })
})

describe('inbox: convert atomicity', () => {
  it('persists task creation + linkedTaskId + conv closure as a single observable end-state', () => {
    const item = svc.createInbox({ projectId: 'proj-i', content: 'atomic convert' })
    const conv = svc.createConversation({
      projectId: 'proj-i',
      title: `Research: ${item.content}`,
      createdBy: 'Claude',
      status: 'open',
      participants: [{ name: 'Claude', type: 'agent' as const }]
    })
    svc.linkConversation(conv.id, 'inbox', item.id)
    svc.updateInbox(item.id, { status: 'researching' })
    svc.updateInbox(item.id, { status: 'ready' })

    const task = svc.createTask({ projectId: 'proj-i', title: 'Atomic', status: 'TODO' })
    svc.updateInbox(item.id, { status: 'converted', linkedTaskId: task.id })
    svc.updateConversation(conv.id, {
      status: 'closed',
      decisionSummary: `Converted to ${task.id}`,
      closedAt: new Date().toISOString()
    })

    const finalInbox = svc.getInbox(item.id)!
    const finalTask = svc.getTask(task.id)!
    const finalConv = svc.getConversation(conv.id)!

    expect(finalInbox.status).toBe('converted')
    expect(finalInbox.linkedTaskId).toBe(task.id)
    expect(finalTask.id).toBe(task.id)
    expect(finalConv.status).toBe('closed')
    expect(finalConv.decisionSummary).toContain(task.id)
  })

  it('createTask without projectId is rejected by repository (guards convert)', () => {
    expect(() =>
      svc.createTask({ projectId: undefined as unknown as string, title: 'no project' })
    ).toThrow()
  })
})

describe('inbox: research guards', () => {
  it('research-twice on same item should reuse the existing conversation, not create a second', () => {
    const item = svc.createInbox({ projectId: 'proj-i', content: 'research-twice' })
    const conv1 = svc.createConversation({
      projectId: 'proj-i',
      title: `Research: ${item.content}`,
      createdBy: 'Claude',
      status: 'open',
      participants: [{ name: 'Claude', type: 'agent' as const }]
    })
    svc.linkConversation(conv1.id, 'inbox', item.id)
    svc.updateInbox(item.id, { status: 'researching' })

    const linked = svc.findConversationsByLink('inbox', item.id)
    expect(linked.length).toBe(1)
    expect(linked[0].id).toBe(conv1.id)
  })
})

describe('inbox: archive guards', () => {
  it('archive from researching closes open conversation with reason in decision summary', () => {
    const item = svc.createInbox({ projectId: 'proj-i', content: 'rejected mid-research' })
    const conv = svc.createConversation({
      projectId: 'proj-i',
      title: `Research: ${item.content}`,
      createdBy: 'Claude',
      status: 'open',
      participants: [{ name: 'Claude', type: 'agent' as const }]
    })
    svc.linkConversation(conv.id, 'inbox', item.id)
    svc.updateInbox(item.id, { status: 'researching' })

    const reason = 'duplicate of INBOX-001'
    svc.updateInbox(item.id, { status: 'archived' })
    svc.updateConversation(conv.id, {
      status: 'closed',
      decisionSummary: `Archived: ${reason}`,
      closedAt: new Date().toISOString()
    })

    const closed = svc.getConversation(conv.id)!
    expect(svc.getInbox(item.id)!.status).toBe('archived')
    expect(closed.status).toBe('closed')
    expect(closed.decisionSummary).toContain(reason)
  })
})

describe('inbox: cancel flow (per ADR-011)', () => {
  it.todo('researching → raw via inbox_cancel — tool not yet implemented (tracked in INBOX research)')
})
