import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { SqliteTaskService } from '../sqlite-task-service'
import { InboxConflictError, InboxNotFoundError, InboxStatusError } from './errors'

const TEST_DB = path.join(__dirname, '__test-inbox-lifecycle__.db')
let svc: SqliteTaskService

beforeEach(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  svc = new SqliteTaskService(TEST_DB)
  svc.ensureProject('proj-l', 'Lifecycle Project', '/tmp/l')
})

afterEach(() => {
  svc.close()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
})

describe('startInboxResearch', () => {
  it('happy path: raw → researching, opens linked conv', () => {
    const item = svc.createInbox({ projectId: 'proj-l', content: 'idea' })
    const r = svc.startInboxResearch(item.id, 'Claude')

    expect(r.inboxId).toBe(item.id)
    expect(r.status).toBe('researching')
    expect(svc.getInbox(item.id)?.status).toBe('researching')

    const convs = svc.findConversationsByLink('inbox', item.id)
    expect(convs).toHaveLength(1)
    expect(convs[0].id).toBe(r.conversationId)
    expect(convs[0].title).toContain('Research:')
  })

  it('throws InboxNotFoundError on missing id', () => {
    expect(() => svc.startInboxResearch('INBOX-999', 'Claude')).toThrowError(InboxNotFoundError)
  })

  it('throws InboxStatusError when not raw', () => {
    const item = svc.createInbox({ projectId: 'proj-l', content: 'x' })
    svc.startInboxResearch(item.id, 'Claude')
    expect(() => svc.startInboxResearch(item.id, 'Claude')).toThrowError(InboxStatusError)
  })

  it('throws InboxConflictError when conv already exists', () => {
    const item = svc.createInbox({ projectId: 'proj-l', content: 'x' })
    const conv = svc.createConversation({
      projectId: 'proj-l',
      title: 'pre-existing',
      createdBy: 'human',
      status: 'open'
    })
    svc.linkConversation(conv.id, 'inbox', item.id)
    expect(() => svc.startInboxResearch(item.id, 'Claude')).toThrowError(InboxConflictError)
    expect(svc.getInbox(item.id)?.status).toBe('raw')
  })
})

describe('convertInboxToTask', () => {
  it('happy path: creates task, marks converted, closes linked convs', () => {
    const item = svc.createInbox({ projectId: 'proj-l', content: 'feature idea' })
    svc.startInboxResearch(item.id, 'Claude')

    const r = svc.convertInboxToTask(item.id, {
      title: 'Build feature',
      priority: 'high',
      labels: ['feat'],
      body: 'detailed body'
    })

    expect(r.taskId).toMatch(/^TASK-/)
    expect(r.task.title).toBe('Build feature')
    expect(r.task.body).toBe('detailed body')

    const inbox = svc.getInbox(item.id)
    expect(inbox?.status).toBe('converted')
    expect(inbox?.linkedTaskId).toBe(r.taskId)

    const convs = svc.findConversationsByLink('inbox', item.id)
    expect(convs[0].status).toBe('closed')
    expect(convs[0].decisionSummary).toContain(r.taskId)
  })

  it('throws InboxStatusError when already converted', () => {
    const item = svc.createInbox({ projectId: 'proj-l', content: 'x' })
    svc.convertInboxToTask(item.id, { title: 'task A' })
    expect(() => svc.convertInboxToTask(item.id, { title: 'task B' })).toThrowError(
      InboxStatusError
    )
  })

  it('throws InboxConflictError when no projectId', () => {
    const item = svc.createInbox({ projectId: undefined, content: 'orphan' })
    expect(() => svc.convertInboxToTask(item.id, { title: 'x' })).toThrowError(InboxConflictError)
  })
})

describe('archiveInbox', () => {
  it('happy path: marks archived, closes convs', () => {
    const item = svc.createInbox({ projectId: 'proj-l', content: 'reject this' })
    svc.startInboxResearch(item.id, 'Claude')

    const r = svc.archiveInbox(item.id, 'duplicate')

    expect(r.status).toBe('archived')
    const convs = svc.findConversationsByLink('inbox', item.id)
    expect(convs[0].status).toBe('closed')
    expect(convs[0].decisionSummary).toBe('Archived: duplicate')
  })

  it('throws InboxStatusError when already converted', () => {
    const item = svc.createInbox({ projectId: 'proj-l', content: 'x' })
    svc.convertInboxToTask(item.id, { title: 'task' })
    expect(() => svc.archiveInbox(item.id)).toThrowError(InboxStatusError)
  })
})

describe('transaction rollback (atomicity)', () => {
  it('rolls back conversation creation when inbox update fails', () => {
    const item = svc.createInbox({ projectId: 'proj-l', content: 'rollback test' })

    // Force inbox.update to throw mid-transaction (after conv created + linked)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lifecycle = (svc as any).inboxLifecycle
    const origUpdate = lifecycle.inbox.update.bind(lifecycle.inbox)
    lifecycle.inbox.update = () => {
      throw new Error('simulated failure')
    }

    expect(() => svc.startInboxResearch(item.id, 'Claude')).toThrow('simulated failure')

    lifecycle.inbox.update = origUpdate

    expect(svc.getInbox(item.id)?.status).toBe('raw')
    expect(svc.findConversationsByLink('inbox', item.id)).toHaveLength(0)
  })

  it('rolls back task creation when inbox update fails mid-convert', () => {
    const item = svc.createInbox({ projectId: 'proj-l', content: 'convert rollback' })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lifecycle = (svc as any).inboxLifecycle
    const origUpdate = lifecycle.inbox.update.bind(lifecycle.inbox)
    lifecycle.inbox.update = () => {
      throw new Error('simulated failure')
    }

    expect(() => svc.convertInboxToTask(item.id, { title: 'should rollback' })).toThrow(
      'simulated failure'
    )

    lifecycle.inbox.update = origUpdate

    expect(svc.getInbox(item.id)?.status).toBe('raw')
    expect(
      svc.findTasks({ projectId: 'proj-l' }).filter((t) => t.title === 'should rollback')
    ).toHaveLength(0)
  })
})
