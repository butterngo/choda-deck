import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { SqliteTaskService } from '../sqlite-task-service'
import { InboxConflictError, InboxNotFoundError, InboxStatusError } from './errors'

const TEST_DB = path.join(__dirname, '__test-inbox-lifecycle__.db')

// TASK-2247 — conversion now requires a template-conforming body.
const BODY =
  '## Context\n\nwhy\n\n## Acceptance\n\n- [ ] it works\n\n## Test Plan\n\n- unit\n\n## Related\n\n- none\n'

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
      body: BODY
    })

    expect(r.taskId).toMatch(/^TASK-/)
    expect(r.task.title).toBe('Build feature')
    expect(r.task.body).toBe(BODY)

    const inbox = await svc.getInbox(item.id)
    expect(inbox?.status).toBe('converted')
    expect(inbox?.linkedTaskId).toBe(r.taskId)

    const convs = await svc.findConversationsByLink('inbox', item.id)
    expect(convs[0].status).toBe('decided')
    expect(convs[0].decisionSummary).toContain(r.taskId)
  })

  it('throws InboxStatusError when already converted', async () => {
    const item = await svc.createInbox({ projectId: 'proj-l', content: 'x' })
    await svc.convertInboxToTask(item.id, { title: 'task A', body: BODY })
    await expect(svc.convertInboxToTask(item.id, { title: 'task B', body: BODY })).rejects.toThrow(
      InboxStatusError
    )
  })

  it('throws InboxConflictError when no projectId', async () => {
    const item = await svc.createInbox({ projectId: undefined, content: 'orphan' })
    await expect(svc.convertInboxToTask(item.id, { title: 'x' })).rejects.toThrow(InboxConflictError)
  })

  // P6 (ADR-032 Pillar 6, TASK-993): progressive localization is a soft-warn, never a gate.
  it('soft-warns (does not throw) when workspaceId is null at convert', async () => {
    const item = await svc.createInbox({ projectId: 'proj-l', content: 'unlocalized idea' })
    const r = await svc.convertInboxToTask(item.id, { title: 'unlocalized task', body: BODY })
    expect(r.taskId).toMatch(/^TASK-/)
    expect(r.localizationWarning).toContain('no workspaceId')
    expect((await svc.getInbox(item.id))?.status).toBe('converted')
  })

  it('no localizationWarning when the item was localized before convert', async () => {
    const item = await svc.createInbox({
      projectId: 'proj-l',
      content: 'localized idea',
      workspaceId: 'ws-l'
    })
    const r = await svc.convertInboxToTask(item.id, { title: 'localized task', body: BODY })
    expect(r.localizationWarning).toBeUndefined()
  })
})

describe('archiveInbox', () => {
  it('happy path: marks archived, closes convs', async () => {
    const item = await svc.createInbox({ projectId: 'proj-l', content: 'reject this' })
    await svc.startInboxResearch(item.id, 'Claude')

    const r = await svc.archiveInbox(item.id, 'duplicate')

    expect(r.status).toBe('archived')
    const convs = await svc.findConversationsByLink('inbox', item.id)
    expect(convs[0].status).toBe('decided')
    expect(convs[0].decisionSummary).toBe('Archived: duplicate')
  })

  it('throws InboxStatusError when already converted', async () => {
    const item = await svc.createInbox({ projectId: 'proj-l', content: 'x' })
    await svc.convertInboxToTask(item.id, { title: 'task', body: BODY })
    await expect(svc.archiveInbox(item.id)).rejects.toThrow(InboxStatusError)
  })
})

// TASK-3140 — the close is an append-only decision turn, so a refold agrees.
describe('closing linked conversations through the log', () => {
  async function linkedPlainConv(inboxId: string): Promise<string> {
    const conv = await svc.createConversation({
      projectId: 'proj-l',
      title: 'no participants',
      createdBy: 'human',
      status: 'open'
    })
    await svc.linkConversation(conv.id, 'inbox', inboxId)
    return conv.id
  }

  it('archive appends a decision turn and the thread is decided', async () => {
    const item = await svc.createInbox({ projectId: 'proj-l', content: 'archive me' })
    const convId = await linkedPlainConv(item.id)

    await svc.archiveInbox(item.id, 'duplicate')

    const decisions = (await svc.getConversationMessages(convId)).filter(
      (m) => m.kind === 'decision'
    )
    expect(decisions.map((m) => m.content)).toEqual(['Archived: duplicate'])
    expect((await svc.getConversation(convId))?.status).toBe('decided')
  })

  it('archive survives a refold — still decided with the same summary', async () => {
    const item = await svc.createInbox({ projectId: 'proj-l', content: 'refold me' })
    const convId = await linkedPlainConv(item.id)

    await svc.archiveInbox(item.id, 'stale')
    svc.recomputeConversationHeader(convId)

    const after = await svc.getConversation(convId)
    expect(after?.status).toBe('decided')
    expect(after?.decisionSummary).toBe('Archived: stale')
  })

  it('convert appends a "Converted to TASK-" decision turn and stays decided after refold', async () => {
    const item = await svc.createInbox({ projectId: 'proj-l', content: 'convert me' })
    const convId = await linkedPlainConv(item.id)

    const r = await svc.convertInboxToTask(item.id, { title: 'the task', body: BODY })
    svc.recomputeConversationHeader(convId)

    const decision = (await svc.getConversationMessages(convId)).find((m) => m.kind === 'decision')
    expect(decision?.content.startsWith(`Converted to ${r.taskId}`)).toBe(true)
    expect(decision?.content.startsWith('Converted to TASK-')).toBe(true)
    expect((await svc.getConversation(convId))?.status).toBe('decided')
  })

  it('a research thread (Butter + researcher) gets one signoff per participant and closes', async () => {
    const item = await svc.createInbox({ projectId: 'proj-l', content: 'researched' })
    const { conversationId } = await svc.startInboxResearch(item.id, 'Claude')

    await svc.archiveInbox(item.id, 'not mine')
    svc.recomputeConversationHeader(conversationId)

    const signoffs = (await svc.getConversationMessages(conversationId)).filter(
      (m) => m.kind === 'signoff'
    )
    expect(signoffs.map((m) => m.authorName).sort()).toEqual(['Butter', 'Claude'])
    expect(signoffs.every((m) => m.content === 'Signed off by inbox_archive')).toBe(true)
    const after = await svc.getConversation(conversationId)
    expect(after?.status).toBe('decided')
    expect(after?.decisionSummary).toBe('Archived: not mine')
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

    await expect(svc.convertInboxToTask(item.id, { title: 'should rollback', body: BODY })).rejects.toThrow(
      'simulated failure'
    )

    lifecycle.inbox.update = origUpdate

    expect((await svc.getInbox(item.id))?.status).toBe('raw')
    expect(
      (await svc.findTasks({ projectId: 'proj-l' })).filter((t) => t.title === 'should rollback')
    ).toHaveLength(0)
  })
})
