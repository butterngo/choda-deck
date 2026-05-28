import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { SqliteTaskService } from '../sqlite-task-service'
import * as fs from 'fs'
import * as path from 'path'

const TEST_DB = path.join(__dirname, '__test-inbox__.db')
let svc: SqliteTaskService

beforeAll(async () => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  svc = new SqliteTaskService(TEST_DB)
  await svc.ensureProject('proj-i', 'Inbox Project', '/tmp/i')
})

afterAll(async () => {
  await svc.close()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
})

describe('inbox: id + counter', () => {
  it('auto-increments globally — INBOX-001, INBOX-002', async () => {
    const a = await svc.createInbox({ projectId: 'proj-i', content: 'first idea' })
    const b = await svc.createInbox({ projectId: 'proj-i', content: 'second idea' })
    expect(a.id).toBe('INBOX-001')
    expect(b.id).toBe('INBOX-002')
    expect(a.status).toBe('raw')
  })
})

describe('inbox: find + filter', () => {
  it('finds by projectId', async () => {
    const rows = await svc.findInbox({ projectId: 'proj-i' })
    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(rows.every((r) => r.projectId === 'proj-i')).toBe(true)
  })

  it('filters by status', async () => {
    const raw = await svc.findInbox({ projectId: 'proj-i', status: 'raw' })
    expect(raw.every((r) => r.status === 'raw')).toBe(true)
  })
})

describe('inbox: state machine', () => {
  it('raw → researching opens linked conversation', async () => {
    const item = await svc.createInbox({ projectId: 'proj-i', content: 'needs research' })
    const conv = await svc.createConversation({
      projectId: 'proj-i',
      title: `Research: ${item.content}`,
      createdBy: 'Claude',
      status: 'open',
      participants: [{ name: 'Claude' }]
    })
    await svc.linkConversation(conv.id, 'inbox', item.id)
    const updated = await svc.updateInbox(item.id, { status: 'researching' })
    expect(updated.status).toBe('researching')

    const linked = await svc.findConversationsByLink('inbox', item.id)
    expect(linked.length).toBe(1)
    expect(linked[0].id).toBe(conv.id)
  })

  it('researching → ready', async () => {
    const item = await svc.createInbox({ projectId: 'proj-i', content: 'r2' })
    await svc.updateInbox(item.id, { status: 'researching' })
    const ready = await svc.updateInbox(item.id, { status: 'ready' })
    expect(ready.status).toBe('ready')
  })

  it('ready → converted sets linked_task_id + closes conversation', async () => {
    const item = await svc.createInbox({ projectId: 'proj-i', content: 'to convert' })
    const conv = await svc.createConversation({
      projectId: 'proj-i',
      title: `Research: ${item.content}`,
      createdBy: 'Claude',
      status: 'open',
      participants: [{ name: 'Claude' }]
    })
    await svc.linkConversation(conv.id, 'inbox', item.id)
    await svc.updateInbox(item.id, { status: 'researching' })
    await svc.updateInbox(item.id, { status: 'ready' })

    const task = await svc.createTask({
      projectId: 'proj-i',
      title: 'Converted task',
      status: 'TODO'
    })
    await svc.updateInbox(item.id, { status: 'converted', linkedTaskId: task.id })
    await svc.updateConversation(conv.id, {
      status: 'decided',
      decisionSummary: `Converted to ${task.id}`,
      decidedAt: new Date().toISOString()
    })

    const final = await svc.getInbox(item.id)!
    expect(final.status).toBe('converted')
    expect(final.linkedTaskId).toBe(task.id)

    const closedConv = await svc.getConversation(conv.id)!
    expect(closedConv.status).toBe('decided')
    expect(closedConv.decisionSummary).toContain(task.id)
  })

  it('archive drives linked conversation to decided', async () => {
    const item = await svc.createInbox({ projectId: 'proj-i', content: 'reject' })
    const conv = await svc.createConversation({
      projectId: 'proj-i',
      title: `Research: ${item.content}`,
      createdBy: 'Claude',
      status: 'open',
      participants: [{ name: 'Claude' }]
    })
    await svc.linkConversation(conv.id, 'inbox', item.id)
    await svc.updateInbox(item.id, { status: 'archived' })
    await svc.updateConversation(conv.id, {
      status: 'decided',
      decisionSummary: 'Archived',
      decidedAt: new Date().toISOString()
    })

    expect((await svc.getInbox(item.id))!.status).toBe('archived')
    expect((await svc.getConversation(conv.id))!.status).toBe('decided')
  })
})

describe('inbox: delete', () => {
  it('deletes raw item', async () => {
    const item = await svc.createInbox({ projectId: 'proj-i', content: 'to delete' })
    expect(item.status).toBe('raw')
    await svc.deleteInbox(item.id)
    expect(await svc.getInbox(item.id)).toBeNull()
  })
})

describe('inbox: convert atomicity', () => {
  it('persists task creation + linkedTaskId + conv closure as a single observable end-state', async () => {
    const item = await svc.createInbox({ projectId: 'proj-i', content: 'atomic convert' })
    const conv = await svc.createConversation({
      projectId: 'proj-i',
      title: `Research: ${item.content}`,
      createdBy: 'Claude',
      status: 'open',
      participants: [{ name: 'Claude' }]
    })
    await svc.linkConversation(conv.id, 'inbox', item.id)
    await svc.updateInbox(item.id, { status: 'researching' })
    await svc.updateInbox(item.id, { status: 'ready' })

    const task = await svc.createTask({ projectId: 'proj-i', title: 'Atomic', status: 'TODO' })
    await svc.updateInbox(item.id, { status: 'converted', linkedTaskId: task.id })
    await svc.updateConversation(conv.id, {
      status: 'decided',
      decisionSummary: `Converted to ${task.id}`,
      decidedAt: new Date().toISOString()
    })

    const finalInbox = await svc.getInbox(item.id)!
    const finalTask = await svc.getTask(task.id)!
    const finalConv = await svc.getConversation(conv.id)!

    expect(finalInbox.status).toBe('converted')
    expect(finalInbox.linkedTaskId).toBe(task.id)
    expect(finalTask.id).toBe(task.id)
    expect(finalConv.status).toBe('decided')
    expect(finalConv.decisionSummary).toContain(task.id)
  })

  it('createTask without projectId is rejected by repository (guards convert)', async () => {
    await expect(svc.createTask({ projectId: undefined as unknown as string, title: 'no project' })).rejects.toThrow()
  })
})

describe('inbox: research guards', () => {
  it('research-twice on same item should reuse the existing conversation, not create a second', async () => {
    const item = await svc.createInbox({ projectId: 'proj-i', content: 'research-twice' })
    const conv1 = await svc.createConversation({
      projectId: 'proj-i',
      title: `Research: ${item.content}`,
      createdBy: 'Claude',
      status: 'open',
      participants: [{ name: 'Claude' }]
    })
    await svc.linkConversation(conv1.id, 'inbox', item.id)
    await svc.updateInbox(item.id, { status: 'researching' })

    const linked = await svc.findConversationsByLink('inbox', item.id)
    expect(linked.length).toBe(1)
    expect(linked[0].id).toBe(conv1.id)
  })
})

describe('inbox: archive guards', () => {
  it('archive from researching closes open conversation with reason in decision summary', async () => {
    const item = await svc.createInbox({ projectId: 'proj-i', content: 'rejected mid-research' })
    const conv = await svc.createConversation({
      projectId: 'proj-i',
      title: `Research: ${item.content}`,
      createdBy: 'Claude',
      status: 'open',
      participants: [{ name: 'Claude' }]
    })
    await svc.linkConversation(conv.id, 'inbox', item.id)
    await svc.updateInbox(item.id, { status: 'researching' })

    const reason = 'duplicate of INBOX-001'
    await svc.updateInbox(item.id, { status: 'archived' })
    await svc.updateConversation(conv.id, {
      status: 'decided',
      decisionSummary: `Archived: ${reason}`,
      decidedAt: new Date().toISOString()
    })

    const closed = (await svc.getConversation(conv.id))!
    expect((await svc.getInbox(item.id))!.status).toBe('archived')
    expect(closed.status).toBe('decided')
    expect(closed.decisionSummary).toContain(reason)
  })
})

describe('inbox: cancel flow (per ADR-011)', () => {
  it.todo('researching → raw via inbox_cancel — tool not yet implemented (tracked in INBOX research)')
})
