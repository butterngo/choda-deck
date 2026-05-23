import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import {
  describeIfDocker,
  startPostgresTestEnv,
  stopPostgresTestEnv,
  type PgTestEnv
} from '../../../../../test/postgres-harness'
import { migrate } from '../migrations'
import { PostgresProjectRepository } from '../project-repository.pg'
import { PostgresConversationRepository } from '../conversation-repository.pg'

describeIfDocker('PostgresConversationRepository', () => {
  let env: PgTestEnv
  let projects: PostgresProjectRepository
  let conversations: PostgresConversationRepository
  let eventDir: string
  let originalEventDirEnv: string | undefined

  beforeAll(async () => {
    env = await startPostgresTestEnv()
    await migrate(env.conn)
    projects = new PostgresProjectRepository(env.conn)
    conversations = new PostgresConversationRepository(env.conn)
  }, 120_000)

  afterAll(async () => {
    if (env) await stopPostgresTestEnv(env)
  }, 30_000)

  beforeEach(async () => {
    // Isolate the JSONL event file per test — emit is fire-and-forget but
    // the role-fanout assertions read the file back.
    eventDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choda-conv-pg-'))
    originalEventDirEnv = process.env.CHODA_EVENT_DIR
    process.env.CHODA_EVENT_DIR = eventDir

    // Order matters: actions/links/messages/participants FK to conversations.
    await env.conn.query('DELETE FROM conversation_actions')
    await env.conn.query('DELETE FROM conversation_links')
    await env.conn.query('DELETE FROM conversation_messages')
    await env.conn.query('DELETE FROM conversation_participants')
    await env.conn.query('DELETE FROM conversations')
    await env.conn.query('DELETE FROM projects')
    await projects.ensure('p', 'P', '/abs/p')
  })

  afterEach(() => {
    if (originalEventDirEnv === undefined) delete process.env.CHODA_EVENT_DIR
    else process.env.CHODA_EVENT_DIR = originalEventDirEnv
    fs.rmSync(eventDir, { recursive: true, force: true })
  })

  function readEventLines(projectId: string): unknown[] {
    const file = path.join(eventDir, `${projectId}.jsonl`)
    if (!fs.existsSync(file)) return []
    return fs
      .readFileSync(file, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as unknown)
  }

  it('create persists owner_type/owner_session_id, adds participants atomically', async () => {
    const c = await conversations.create({
      projectId: 'p',
      title: 'Test conv',
      createdBy: 'butter',
      ownerType: 'interactive',
      ownerSessionId: 'SESSION-1',
      participants: [
        { name: 'butter', type: 'human' },
        { name: 'claude', type: 'agent', role: 'reviewer' }
      ]
    })
    expect(c.id).toMatch(/^CONV-/)
    expect(c.status).toBe('open')
    expect(c.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    const participants = await conversations.getParticipants(c.id)
    expect(participants.map((p) => p.name).sort()).toEqual(['butter', 'claude'])
    expect(participants.find((p) => p.name === 'claude')?.role).toBe('reviewer')
  })

  it('update partial fields, get/findByProject filter by status', async () => {
    const a = await conversations.create({
      id: 'CONV-A',
      projectId: 'p',
      title: 'Open one',
      createdBy: 'butter'
    })
    await conversations.create({
      id: 'CONV-B',
      projectId: 'p',
      title: 'Decided one',
      createdBy: 'butter',
      status: 'decided'
    })

    const updated = await conversations.update(a.id, {
      title: 'Renamed',
      decisionSummary: 'choice X',
      closedAt: '2026-05-23T11:00:00.000Z'
    })
    expect(updated.title).toBe('Renamed')
    expect(updated.decisionSummary).toBe('choice X')

    const decided = await conversations.findByProject('p', 'decided')
    expect(decided.map((c) => c.id)).toEqual(['CONV-B'])

    const all = await conversations.findByProject('p')
    expect(all.map((c) => c.id).sort()).toEqual(['CONV-A', 'CONV-B'])
  })

  it('update with empty input returns current row', async () => {
    const c = await conversations.create({ projectId: 'p', title: 't', createdBy: 'b' })
    const got = await conversations.update(c.id, {})
    expect(got).toEqual(c)
  })

  it('addParticipant upserts (re-add changes role)', async () => {
    const c = await conversations.create({ projectId: 'p', title: 't', createdBy: 'b' })
    await conversations.addParticipant(c.id, 'rev', 'agent', 'reviewer')
    await conversations.addParticipant(c.id, 'rev', 'agent', 'planner')
    const ps = await conversations.getParticipants(c.id)
    expect(ps).toHaveLength(1)
    expect(ps[0].role).toBe('planner')

    await conversations.removeParticipant(c.id, 'rev')
    expect(await conversations.getParticipants(c.id)).toEqual([])
  })

  it('addMessage with metadata round-trips via JSONB; messages ordered by created_at', async () => {
    const c = await conversations.create({ projectId: 'p', title: 't', createdBy: 'b' })
    const m1 = await conversations.addMessage({
      conversationId: c.id,
      authorName: 'butter',
      content: 'first',
      metadata: { codeChanges: ['file.ts'] }
    })
    expect(m1.metadata).toEqual({ codeChanges: ['file.ts'] })

    await conversations.addMessage({
      conversationId: c.id,
      authorName: 'claude',
      content: 'second',
      messageType: 'answer'
    })

    const msgs = await conversations.getMessages(c.id)
    expect(msgs.map((m) => m.content)).toEqual(['first', 'second'])
  })

  // ── role-routed event fanout ─────────────────────────────────────────────
  it('addMessage with messageType=question emits a JSONL event when a role participant exists', async () => {
    const c = await conversations.create({
      projectId: 'p',
      title: 'role-routed',
      createdBy: 'butter',
      participants: [{ name: 'claude', type: 'agent', role: 'reviewer' }]
    })
    await conversations.addMessage({
      conversationId: c.id,
      authorName: 'butter',
      content: 'review please',
      messageType: 'question'
    })
    const events = readEventLines('p')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'message.question',
      conversationId: c.id,
      roles: ['reviewer'],
      author: 'butter'
    })
  })

  it('addMessage with no role participants does not emit', async () => {
    const c = await conversations.create({
      projectId: 'p',
      title: 'no roles',
      createdBy: 'butter',
      participants: [{ name: 'butter', type: 'human' }] // no role
    })
    await conversations.addMessage({
      conversationId: c.id,
      authorName: 'butter',
      content: 'q?',
      messageType: 'question'
    })
    expect(readEventLines('p')).toEqual([])
  })

  it('comment-type messages do NOT emit (only question/answer do)', async () => {
    const c = await conversations.create({
      projectId: 'p',
      title: 'comment only',
      createdBy: 'butter',
      participants: [{ name: 'claude', type: 'agent', role: 'reviewer' }]
    })
    await conversations.addMessage({
      conversationId: c.id,
      authorName: 'butter',
      content: 'just a note'
    })
    expect(readEventLines('p')).toEqual([])
  })

  it('targetRole filters fanout — only matching role triggers emit', async () => {
    const c = await conversations.create({
      projectId: 'p',
      title: 'targeted',
      createdBy: 'butter',
      participants: [
        { name: 'claude-rev', type: 'agent', role: 'reviewer' },
        { name: 'claude-impl', type: 'agent', role: 'implementer' }
      ]
    })

    // Targeted role exists → emit with roles=[targetRole]
    await conversations.addMessage({
      conversationId: c.id,
      authorName: 'butter',
      content: 'review please',
      messageType: 'question',
      targetRole: 'reviewer'
    })

    // Targeted role NOT in participant set → no emit
    await conversations.addMessage({
      conversationId: c.id,
      authorName: 'butter',
      content: 'huh?',
      messageType: 'question',
      targetRole: 'designer'
    })

    const events = readEventLines('p')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ roles: ['reviewer'] })
  })

  it('cross-project fanout — role address "<projectId>/<workspaceId>" appends to both projects', async () => {
    await projects.ensure('q', 'Q', '/abs/q')
    const c = await conversations.create({
      projectId: 'p',
      title: 'fanout',
      createdBy: 'butter',
      participants: [{ name: 'claude-q', type: 'agent', role: 'q/main' }]
    })
    await conversations.addMessage({
      conversationId: c.id,
      authorName: 'butter',
      content: 'cross-project ping',
      messageType: 'question'
    })

    expect(readEventLines('p')).toHaveLength(1)
    expect(readEventLines('q')).toHaveLength(1)
  })

  it('unknown projectId in role address is skipped (no throw, no emit to missing target)', async () => {
    const c = await conversations.create({
      projectId: 'p',
      title: 'bad fanout',
      createdBy: 'butter',
      participants: [{ name: 'ghost', type: 'agent', role: 'nonexistent/main' }]
    })
    await conversations.addMessage({
      conversationId: c.id,
      authorName: 'butter',
      content: 'who?',
      messageType: 'question'
    })
    expect(readEventLines('p')).toHaveLength(1)
    expect(readEventLines('nonexistent')).toEqual([])
  })

  // ── Actions ──────────────────────────────────────────────────────────────
  it('addAction defaults pending; updateAction sets status + linked_task_id', async () => {
    const c = await conversations.create({ projectId: 'p', title: 't', createdBy: 'b' })
    const a = await conversations.addAction({
      conversationId: c.id,
      assignee: 'butter',
      description: 'do thing'
    })
    expect(a.status).toBe('pending')

    const updated = await conversations.updateAction(a.id, {
      status: 'done',
      linkedTaskId: 'TASK-001'
    })
    expect(updated.status).toBe('done')
    expect(updated.linkedTaskId).toBe('TASK-001')

    const all = await conversations.getActions(c.id)
    expect(all).toHaveLength(1)
  })

  // ── Links ────────────────────────────────────────────────────────────────
  it('link dedupes via ON CONFLICT; findByLink joins back to conversations', async () => {
    const c = await conversations.create({ projectId: 'p', title: 't', createdBy: 'b' })
    await conversations.link(c.id, 'task', 'TASK-001')
    await conversations.link(c.id, 'task', 'TASK-001') // dedup
    await conversations.link(c.id, 'commit', 'abc123')

    const links = await conversations.getLinks(c.id)
    expect(links).toHaveLength(2)

    const byLink = await conversations.findByLink('task', 'TASK-001')
    expect(byLink.map((c) => c.id)).toEqual([c.id])

    await conversations.unlink(c.id, 'task', 'TASK-001')
    expect(await conversations.getLinks(c.id)).toHaveLength(1)
  })

  // ── Delete cascade ───────────────────────────────────────────────────────
  it('delete clears all 4 child tables in one transaction', async () => {
    const c = await conversations.create({
      projectId: 'p',
      title: 'kill me',
      createdBy: 'b',
      participants: [{ name: 'butter', type: 'human' }]
    })
    await conversations.addMessage({
      conversationId: c.id,
      authorName: 'butter',
      content: 'hi'
    })
    await conversations.addAction({
      conversationId: c.id,
      assignee: 'butter',
      description: 'x'
    })
    await conversations.link(c.id, 'task', 'TASK-001')

    await conversations.delete(c.id)

    expect(await conversations.get(c.id)).toBeNull()
    expect(await conversations.getParticipants(c.id)).toEqual([])
    expect(await conversations.getMessages(c.id)).toEqual([])
    expect(await conversations.getActions(c.id)).toEqual([])
    expect(await conversations.getLinks(c.id)).toEqual([])
  })
})
