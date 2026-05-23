import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { SqliteTaskService } from '../sqlite-task-service'
import { InboxConflictError, InboxNotFoundError, InboxStatusError } from './errors'

const TEST_DB = path.join(__dirname, '__test-inbox-lifecycle__.db')
let svc: SqliteTaskService

beforeEach(async () => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  svc = new SqliteTaskService(TEST_DB)
  await svc.ensureProject('proj-l', 'Lifecycle Project', '/tmp/l')
})

afterEach(async () => {
  await svc.close()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
})

describe('startInboxResearch', () => {
  it('happy path: raw → researching, opens linked conv', async () => {
    const item = await svc.createInbox({ projectId: 'proj-l', content: 'idea' })
    const r = await svc.startInboxResearch(item.id, 'Claude')

    expect(r.inboxId).toBe(item.id)
    expect(r.status).toBe('researching')
    expect((await svc.getInbox(item.id))?.status).toBe('researching')

    const convs = await svc.findConversationsByLink('inbox', item.id)
    expect(convs).toHaveLength(1)
    expect(convs[0].id).toBe(r.conversationId)
    expect(convs[0].title).toContain('Research:')
  })

  it('throws InboxNotFoundError on missing id', async () => {
    await expect(svc.startInboxResearch('INBOX-999', 'Claude')).rejects.toThrow(InboxNotFoundError)
  })

  it('throws InboxStatusError when not raw', async () => {
    const item = await svc.createInbox({ projectId: 'proj-l', content: 'x' })
    await svc.startInboxResearch(item.id, 'Claude')
    await expect(svc.startInboxResearch(item.id, 'Claude')).rejects.toThrow(InboxStatusError)
  })

  it('throws InboxConflictError when conv already exists', async () => {
    const item = await svc.createInbox({ projectId: 'proj-l', content: 'x' })
    const conv = await svc.createConversation({
      projectId: 'proj-l',
      title: 'pre-existing',
      createdBy: 'human',
      status: 'open'
    })
    await svc.linkConversation(conv.id, 'inbox', item.id)
    await expect(svc.startInboxResearch(item.id, 'Claude')).rejects.toThrow(InboxConflictError)
    expect((await svc.getInbox(item.id))?.status).toBe('raw')
  })
})

describe('convertInboxToTask', () => {
  it('happy path: creates task, marks converted, closes linked convs', async () => {
    const item = await svc.createInbox({ projectId: 'proj-l', content: 'feature idea' })
    await svc.startInboxResearch(item.id, 'Claude')

    const r = await svc.convertInboxToTask(item.id, {
      title: 'Build feature',
      priority: 'high',
      labels: ['feat'],
      body: 'detailed body'
    })

    expect(r.taskId).toMatch(/^TASK-/)
    expect(r.task.title).toBe('Build feature')
    expect(r.task.body).toBe('detailed body')

    const inbox = await svc.getInbox(item.id)
    expect(inbox?.status).toBe('converted')
    expect(inbox?.linkedTaskId).toBe(r.taskId)

    const convs = await svc.findConversationsByLink('inbox', item.id)
    expect(convs[0].status).toBe('closed')
    expect(convs[0].decisionSummary).toContain(r.taskId)
  })

  it('throws InboxStatusError when already converted', async () => {
    const item = await svc.createInbox({ projectId: 'proj-l', content: 'x' })
    await svc.convertInboxToTask(item.id, { title: 'task A' })
    await expect(svc.convertInboxToTask(item.id, { title: 'task B' })).rejects.toThrow(
      InboxStatusError
    )
  })

  it('throws InboxConflictError when no projectId', async () => {
    const item = await svc.createInbox({ projectId: undefined, content: 'orphan' })
    await expect(svc.convertInboxToTask(item.id, { title: 'x' })).rejects.toThrow(InboxConflictError)
  })
})

describe('archiveInbox', () => {
  it('happy path: marks archived, closes convs', async () => {
    const item = await svc.createInbox({ projectId: 'proj-l', content: 'reject this' })
    await svc.startInboxResearch(item.id, 'Claude')

    const r = await svc.archiveInbox(item.id, 'duplicate')

    expect(r.status).toBe('archived')
    const convs = await svc.findConversationsByLink('inbox', item.id)
    expect(convs[0].status).toBe('closed')
    expect(convs[0].decisionSummary).toBe('Archived: duplicate')
  })

  it('throws InboxStatusError when already converted', async () => {
    const item = await svc.createInbox({ projectId: 'proj-l', content: 'x' })
    await svc.convertInboxToTask(item.id, { title: 'task' })
    await expect(svc.archiveInbox(item.id)).rejects.toThrow(InboxStatusError)
  })
})

describe('transaction rollback (atomicity)', () => {
  it('rolls back conversation creation when inbox update fails', async () => {
    const item = await svc.createInbox({ projectId: 'proj-l', content: 'rollback test' })

    // Force inbox.update to throw mid-transaction (after conv created + linked)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lifecycle = (svc as any).inboxLifecycle
    const origUpdate = lifecycle.inbox.update.bind(lifecycle.inbox)
    lifecycle.inbox.update = () => {
      throw new Error('simulated failure')
    }

    await expect(svc.startInboxResearch(item.id, 'Claude')).rejects.toThrow('simulated failure')

    lifecycle.inbox.update = origUpdate

    expect((await svc.getInbox(item.id))?.status).toBe('raw')
    expect(await svc.findConversationsByLink('inbox', item.id)).toHaveLength(0)
  })

  it('rolls back task creation when inbox update fails mid-convert', async () => {
    const item = await svc.createInbox({ projectId: 'proj-l', content: 'convert rollback' })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lifecycle = (svc as any).inboxLifecycle
    const origUpdate = lifecycle.inbox.update.bind(lifecycle.inbox)
    lifecycle.inbox.update = () => {
      throw new Error('simulated failure')
    }

    await expect(svc.convertInboxToTask(item.id, { title: 'should rollback' })).rejects.toThrow(
      'simulated failure'
    )

    lifecycle.inbox.update = origUpdate

    expect((await svc.getInbox(item.id))?.status).toBe('raw')
    expect(
      (await svc.findTasks({ projectId: 'proj-l' })).filter((t) => t.title === 'should rollback')
    ).toHaveLength(0)
  })
})
