// Sibling of lifecycle/conversation-lifecycle-service.test.ts — drives the
// 4 conversation composite ops through PostgresTaskService.
//
// Two SQLite-side patterns don't port and are handled differently:
//   - `svc.startSession({...})` (used by session-auto-link tests) — that PG
//     composite isn't implemented until slice 17. Tests that need an active
//     session call `svc.createSession({...})` directly with status='active'.
//   - Rollback monkey-patch tests — tx-bound repos are constructed inside
//     `conn.transaction(async tx => …)` each call, so there's no externally
//     reachable handle to stub. Atomicity rests on conn.transaction, already
//     exercised by other .pg.test.ts (tasks-slice covers task.delete tx).

import { afterAll, beforeAll, beforeEach, expect, it, describe } from 'vitest'
import {
  describeIfDocker,
  startPostgresTestEnv,
  stopPostgresTestEnv,
  type PgTestEnv
} from '../../../test/postgres-harness'
import { PostgresTaskService } from '../postgres-task-service'
import {
  ConversationNotFoundError,
  ConversationStatusError
} from '../lifecycle/errors'

describeIfDocker('PostgresTaskService conversation lifecycle', () => {
  let env: PgTestEnv
  let svc: PostgresTaskService

  async function openFresh(title = 'T'): Promise<string> {
    const conv = await svc.openConversation({
      projectId: 'proj-c',
      title,
      createdBy: 'Butter',
      participants: [{ name: 'Butter', type: 'human' }],
      initialMessage: { content: 'seed', type: 'question' }
    })
    return conv.id
  }

  beforeAll(async () => {
    env = await startPostgresTestEnv()
    svc = new PostgresTaskService(env.conn)
    await svc.initializeAsync()
  }, 120_000)

  afterAll(async () => {
    if (env) await stopPostgresTestEnv(env)
  }, 30_000)

  beforeEach(async () => {
    // Tables touched by conv lifecycle. Order respects FK chains.
    await env.conn.query('DELETE FROM conversation_actions')
    await env.conn.query('DELETE FROM conversation_messages')
    await env.conn.query('DELETE FROM conversation_links')
    await env.conn.query('DELETE FROM conversation_participants')
    await env.conn.query('DELETE FROM conversations')
    await env.conn.query('DELETE FROM relationships')
    await env.conn.query('DELETE FROM tags')
    await env.conn.query('DELETE FROM tasks')
    await env.conn.query('DELETE FROM sessions')
    await env.conn.query('DELETE FROM workspaces')
    await env.conn.query('DELETE FROM projects')
    await env.conn.query(
      "UPDATE global_counters SET last_number = 0 WHERE entity_type IN ('task','session','conv','act')"
    )
    await svc.ensureProject('proj-c', 'Conversation Project', '/tmp/c')
  })

  describe('openConversation', () => {
    it('happy path: creates conv + seeds initial message', async () => {
      const conv = await svc.openConversation({
        projectId: 'proj-c',
        title: 'Design auth',
        createdBy: 'Butter',
        participants: [
          { name: 'Butter', type: 'human' },
          { name: 'Claude', type: 'agent' }
        ],
        initialMessage: { content: 'How should we do auth?', type: 'question' }
      })

      expect(conv.status).toBe('open')
      expect(conv.title).toBe('Design auth')
      const messages = await svc.getConversationMessages(conv.id)
      expect(messages).toHaveLength(1)
      expect(messages[0].content).toBe('How should we do auth?')
      expect(messages[0].messageType).toBe('question')
    })

    it('links to tasks when linkedTasks provided', async () => {
      const task = await svc.createTask({ projectId: 'proj-c', title: 'A' })
      const conv = await svc.openConversation({
        projectId: 'proj-c',
        title: 'T',
        createdBy: 'Butter',
        participants: [{ name: 'Butter', type: 'human' }],
        linkedTasks: [task.id],
        initialMessage: { content: 'hi', type: 'question' }
      })
      const links = await svc.getConversationLinks(conv.id)
      expect(links).toHaveLength(1)
      expect(links[0].linkedId).toBe(task.id)
    })

    it('allows N parallel open conversations per project', async () => {
      const id1 = await openFresh('first')
      const id2 = await openFresh('second')
      const id3 = await openFresh('third')

      const open = await svc.findConversations('proj-c', 'open')
      expect(open.map((c) => c.id).sort()).toEqual([id1, id2, id3].sort())
    })

    it('allows opening new conv while another is decided but not closed', async () => {
      const id1 = await openFresh('first')
      await svc.decideConversation(id1, { author: 'Butter', decision: 'yes' })
      const id2 = await openFresh('second')
      expect((await svc.getConversation(id2))?.status).toBe('open')
    })

    it('tags conv with owner_type=interactive', async () => {
      const conv = await openFresh()
      const row = await env.conn.query<{ owner_type: string | null }>(
        'SELECT owner_type FROM conversations WHERE id = $1',
        [conv]
      )
      expect(row.rows[0].owner_type).toBe('interactive')
    })
  })

  describe('openConversation session auto-link', () => {
    async function createActiveSession(workspaceId?: string): Promise<string> {
      const s = await svc.createSession({
        projectId: 'proj-c',
        workspaceId,
        startedAt: new Date().toISOString(),
        status: 'active'
      })
      return s.id
    }

    it('explicit sessionId: sets ownerSessionId + creates link row', async () => {
      const sessionId = await createActiveSession()
      const conv = await svc.openConversation({
        projectId: 'proj-c',
        title: 'T',
        createdBy: 'Butter',
        participants: [{ name: 'Butter', type: 'human' }],
        initialMessage: { content: 'hi', type: 'question' },
        sessionId
      })

      const row = await env.conn.query<{ owner_session_id: string | null }>(
        'SELECT owner_session_id FROM conversations WHERE id = $1',
        [conv.id]
      )
      expect(row.rows[0].owner_session_id).toBe(sessionId)

      const links = await svc.findConversationsByLink('session', sessionId)
      expect(links.some((c) => c.id === conv.id)).toBe(true)
    })

    it('auto-detect: exactly 1 active session → auto-link', async () => {
      const sessionId = await createActiveSession()
      const convId = await openFresh()

      const links = await svc.findConversationsByLink('session', sessionId)
      expect(links.some((c) => c.id === convId)).toBe(true)
    })

    it('auto-detect: 0 active sessions → no link', async () => {
      const convId = await openFresh()
      const row = await env.conn.query<{ owner_session_id: string | null }>(
        'SELECT owner_session_id FROM conversations WHERE id = $1',
        [convId]
      )
      expect(row.rows[0].owner_session_id).toBeNull()
    })

    it('auto-detect: N > 1 active sessions → no link', async () => {
      await svc.addWorkspace('proj-c', 'ws-1', 'WS 1', '/tmp/ws-1')
      await svc.addWorkspace('proj-c', 'ws-2', 'WS 2', '/tmp/ws-2')
      await createActiveSession('ws-1')
      await createActiveSession('ws-2')
      const convId = await openFresh()
      const row = await env.conn.query<{ owner_session_id: string | null }>(
        'SELECT owner_session_id FROM conversations WHERE id = $1',
        [convId]
      )
      expect(row.rows[0].owner_session_id).toBeNull()
    })

    it('explicit sessionId cross-project → throws', async () => {
      await svc.ensureProject('proj-other', 'Other', '/tmp/o')
      const otherSession = await svc.createSession({
        projectId: 'proj-other',
        startedAt: new Date().toISOString(),
        status: 'active'
      })
      await expect(
        svc.openConversation({
          projectId: 'proj-c',
          title: 'T',
          createdBy: 'Butter',
          participants: [{ name: 'Butter', type: 'human' }],
          initialMessage: { content: 'hi', type: 'question' },
          sessionId: otherSession.id
        })
      ).rejects.toThrow(/belongs to project/)
    })

    it('explicit sessionId non-existent → throws', async () => {
      await expect(
        svc.openConversation({
          projectId: 'proj-c',
          title: 'T',
          createdBy: 'Butter',
          participants: [{ name: 'Butter', type: 'human' }],
          initialMessage: { content: 'hi', type: 'question' },
          sessionId: 'SESSION-NOPE'
        })
      ).rejects.toThrow(/not found/)
    })
  })

  describe('decideConversation', () => {
    it('happy path: adds decision message + flips to decided', async () => {
      const id = await openFresh()
      const r = await svc.decideConversation(id, { author: 'Butter', decision: 'go left' })

      expect(r.conversation.status).toBe('decided')
      expect(r.conversation.decisionSummary).toBe('go left')
      expect(r.actions).toHaveLength(0)
      const msgs = await svc.getConversationMessages(id)
      expect(msgs.at(-1)?.messageType).toBe('decision')
      expect(msgs.at(-1)?.content).toBe('go left')
    })

    it('spawns tasks for actions that include spawnTask', async () => {
      const id = await openFresh()
      const r = await svc.decideConversation(id, {
        author: 'Butter',
        decision: 'proceed',
        actions: [
          {
            assignee: 'Claude',
            description: 'implement',
            spawnTask: { title: 'Impl step', priority: 'high' }
          },
          { assignee: 'Butter', description: 'review' }
        ]
      })

      expect(r.actions).toHaveLength(2)
      expect(r.actions[0].linkedTaskId).toMatch(/^TASK-/)
      expect(r.actions[1].linkedTaskId).toBeNull()

      const links = await svc.getConversationLinks(id)
      expect(links.some((l) => l.linkedId === r.actions[0].linkedTaskId)).toBe(true)
    })

    it('throws ConversationNotFoundError on missing id', async () => {
      await expect(
        svc.decideConversation('CONV-999', { author: 'x', decision: 'y' })
      ).rejects.toThrow(ConversationNotFoundError)
    })
  })

  describe('closeConversation', () => {
    it('happy path: decided → closed', async () => {
      const id = await openFresh()
      await svc.decideConversation(id, { author: 'Butter', decision: 'go' })
      const conv = await svc.closeConversation(id)

      expect(conv.status).toBe('closed')
      expect(conv.closedAt).not.toBeNull()
    })

    it('throws ConversationNotFoundError on missing id', async () => {
      await expect(svc.closeConversation('CONV-999')).rejects.toThrow(ConversationNotFoundError)
    })

    it('throws ConversationStatusError when not decided', async () => {
      const id = await openFresh()
      await expect(svc.closeConversation(id)).rejects.toThrow(ConversationStatusError)
    })
  })

  describe('reopenConversation', () => {
    it('happy path: decided → discussing', async () => {
      const id = await openFresh()
      await svc.decideConversation(id, { author: 'Butter', decision: 'go' })
      const conv = await svc.reopenConversation(id)
      expect(conv.status).toBe('discussing')
    })

    it('allows reopen even when another conversation is active', async () => {
      const id1 = await openFresh('first')
      await svc.decideConversation(id1, { author: 'Butter', decision: 'go' })
      await openFresh('second')

      const conv = await svc.reopenConversation(id1)
      expect(conv.status).toBe('discussing')
    })

    it('throws ConversationNotFoundError on missing id', async () => {
      await expect(svc.reopenConversation('CONV-999')).rejects.toThrow(ConversationNotFoundError)
    })

    it('throws ConversationStatusError when status is open', async () => {
      const id = await openFresh()
      await expect(svc.reopenConversation(id)).rejects.toThrow(ConversationStatusError)
    })

    it('closed → discussing clears closedAt + decidedAt + decisionSummary', async () => {
      const id = await openFresh()
      await svc.decideConversation(id, { author: 'Butter', decision: 'go' })
      await svc.closeConversation(id)
      const conv = await svc.reopenConversation(id)
      expect(conv.status).toBe('discussing')
      expect(conv.decidedAt).toBeNull()
      expect(conv.closedAt).toBeNull()
      expect(conv.decisionSummary).toBeNull()
    })

    it('decided → discussing (skip close) clears decidedAt + decisionSummary', async () => {
      const id = await openFresh()
      await svc.decideConversation(id, { author: 'Butter', decision: 'go' })
      const conv = await svc.reopenConversation(id)
      expect(conv.status).toBe('discussing')
      expect(conv.decidedAt).toBeNull()
      expect(conv.decisionSummary).toBeNull()
    })
  })
})
