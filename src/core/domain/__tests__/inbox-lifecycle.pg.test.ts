// Sibling of lifecycle/inbox-lifecycle-service.test.ts — drives the inbox
// composite ops through PostgresTaskService against a real testcontainer
// Postgres. The 2 rollback-monkey-patch tests from the sqlite suite don't
// port: the tx-bound repos are constructed INSIDE conn.transaction each call,
// so there's no externally-reachable handle to monkey-patch. Atomicity rests
// on conn.transaction itself, which is already covered by the existing pg
// repo tests (e.g. tasks-slice.pg.test.ts exercises task.delete's tx).

import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import {
  describeIfDocker,
  startPostgresTestEnv,
  stopPostgresTestEnv,
  type PgTestEnv
} from '../../../test/postgres-harness'
import { PostgresTaskService } from '../postgres-task-service'
import {
  InboxConflictError,
  InboxNotFoundError,
  InboxStatusError
} from '../lifecycle/errors'

describeIfDocker('PostgresTaskService inbox lifecycle', () => {
  let env: PgTestEnv
  let svc: PostgresTaskService

  beforeAll(async () => {
    env = await startPostgresTestEnv()
    svc = new PostgresTaskService(env.conn)
    await svc.initializeAsync()
  }, 120_000)

  afterAll(async () => {
    if (env) await stopPostgresTestEnv(env)
  }, 30_000)

  beforeEach(async () => {
    // Order matters — tasks must be cleared before inbox so the FK in
    // inbox.linked_task_id doesn't block (there's no FK today but truncate
    // order is still defensive).
    await env.conn.query('DELETE FROM conversation_actions')
    await env.conn.query('DELETE FROM conversation_messages')
    await env.conn.query('DELETE FROM conversation_links')
    await env.conn.query('DELETE FROM conversation_participants')
    await env.conn.query('DELETE FROM conversations')
    await env.conn.query('DELETE FROM relationships')
    await env.conn.query('DELETE FROM tags')
    await env.conn.query('DELETE FROM tasks')
    await env.conn.query('DELETE FROM inbox_items')
    await env.conn.query('DELETE FROM workspaces')
    await env.conn.query('DELETE FROM projects')
    await env.conn.query(
      "UPDATE global_counters SET last_number = 0 WHERE entity_type IN ('inbox','task')"
    )
    await svc.ensureProject('proj-l', 'Lifecycle Project', '/tmp/l')
  })

  // ── startInboxResearch ────────────────────────────────────────────────────
  it('startInboxResearch: happy path raw → researching, opens linked conv', async () => {
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

  it('startInboxResearch: throws InboxNotFoundError on missing id', async () => {
    await expect(svc.startInboxResearch('INBOX-999', 'Claude')).rejects.toThrow(InboxNotFoundError)
  })

  it('startInboxResearch: throws InboxStatusError when not raw', async () => {
    const item = await svc.createInbox({ projectId: 'proj-l', content: 'x' })
    await svc.startInboxResearch(item.id, 'Claude')
    await expect(svc.startInboxResearch(item.id, 'Claude')).rejects.toThrow(InboxStatusError)
  })

  it('startInboxResearch: throws InboxConflictError when conv already exists', async () => {
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

  // ── convertInboxToTask ────────────────────────────────────────────────────
  it('convertInboxToTask: creates task, marks converted, closes linked convs', async () => {
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

  it('convertInboxToTask: throws InboxStatusError when already converted', async () => {
    const item = await svc.createInbox({ projectId: 'proj-l', content: 'x' })
    await svc.convertInboxToTask(item.id, { title: 'task A' })
    await expect(
      svc.convertInboxToTask(item.id, { title: 'task B' })
    ).rejects.toThrow(InboxStatusError)
  })

  it('convertInboxToTask: throws InboxConflictError when no projectId', async () => {
    const item = await svc.createInbox({ projectId: null as unknown as string, content: 'orphan' })
    await expect(svc.convertInboxToTask(item.id, { title: 'x' })).rejects.toThrow(
      InboxConflictError
    )
  })

  // ── archiveInbox ──────────────────────────────────────────────────────────
  it('archiveInbox: happy path marks archived, closes convs', async () => {
    const item = await svc.createInbox({ projectId: 'proj-l', content: 'reject this' })
    await svc.startInboxResearch(item.id, 'Claude')

    const r = await svc.archiveInbox(item.id, 'duplicate')

    expect(r.status).toBe('archived')
    const convs = await svc.findConversationsByLink('inbox', item.id)
    expect(convs[0].status).toBe('closed')
    expect(convs[0].decisionSummary).toBe('Archived: duplicate')
  })

  it('archiveInbox: throws InboxStatusError when already converted', async () => {
    const item = await svc.createInbox({ projectId: 'proj-l', content: 'x' })
    await svc.convertInboxToTask(item.id, { title: 'task' })
    await expect(svc.archiveInbox(item.id)).rejects.toThrow(InboxStatusError)
  })

  // ── atomicity ────────────────────────────────────────────────────────────
  // Verify the composite is wrapped in a tx by triggering a FK violation
  // inside the converted path: pass an explicit projectId that doesn't
  // exist. tasks.create will FK-fail; expect inbox state untouched.
  it('atomicity: convertInboxToTask rolls back inbox state on inner FK error', async () => {
    const item = await svc.createInbox({ projectId: 'proj-l', content: 'rollback test' })
    // Drop the project FK target so the next tasks.create fails. Re-create
    // it after to keep beforeEach happy for the next test.
    await env.conn.query("UPDATE inbox_items SET project_id = 'nonexistent-proj' WHERE id = $1", [
      item.id
    ])

    await expect(svc.convertInboxToTask(item.id, { title: 'should rollback' })).rejects.toThrow()

    const after = await svc.getInbox(item.id)
    expect(after?.status).toBe('raw') // unchanged
    expect(after?.linkedTaskId).toBeNull() // unchanged
  })
})
