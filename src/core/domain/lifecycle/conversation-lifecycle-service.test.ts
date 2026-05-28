import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { SqliteTaskService } from '../sqlite-task-service'
import { ConversationNotFoundError } from './errors'

const TEST_DB = path.join(__dirname, '__test-conversation-lifecycle__.db')
let svc: SqliteTaskService

async function openFresh(title = 'T'): Promise<string> {
  const conv = await svc.openConversation({
    projectId: 'proj-c',
    title,
    createdBy: 'Butter',
    participants: [{ name: 'Butter' }],
    initialMessage: { content: 'seed' }
  })
  return conv.id
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  svc = new SqliteTaskService(TEST_DB)
  await svc.ensureProject('proj-c', 'Conversation Project', '/tmp/c')
})

afterEach(async () => {
  await svc.close()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
})

describe('openConversation', () => {
  it('happy path: creates conv + seeds initial message', async () => {
    const conv = await svc.openConversation({
      projectId: 'proj-c',
      title: 'Design auth',
      createdBy: 'Butter',
      participants: [{ name: 'Butter' }, { name: 'Claude' }],
      initialMessage: { content: 'How should we do auth?' }
    })

    expect(conv.status).toBe('open')
    expect(conv.title).toBe('Design auth')
    expect(conv.signedOff).toEqual([])
    const messages = await svc.getConversationMessages(conv.id)
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toBe('How should we do auth?')
    expect(messages[0].readBy).toEqual([])
  })

  it('links to tasks when linkedTasks provided', async () => {
    const task = await svc.createTask({ projectId: 'proj-c', title: 'A' })
    const conv = await svc.openConversation({
      projectId: 'proj-c',
      title: 'T',
      createdBy: 'Butter',
      participants: [{ name: 'Butter' }],
      linkedTasks: [task.id],
      initialMessage: { content: 'hi' }
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
})

describe('openConversation R3 ownership tag', () => {
  it('tags conv with owner_type=interactive', async () => {
    const conv = await svc.openConversation({
      projectId: 'proj-c',
      title: 'Interactive',
      createdBy: 'Butter',
      participants: [{ name: 'Butter' }],
      initialMessage: { content: 'hi' }
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (svc as any).db as import('better-sqlite3').Database
    const row = db
      .prepare('SELECT owner_type FROM conversations WHERE id = ?')
      .get(conv.id) as { owner_type: string | null }
    expect(row.owner_type).toBe('interactive')
  })
})

describe('openConversation session auto-link', () => {
  async function openConv(extra?: { sessionId?: string }): Promise<string> {
    return (await svc.openConversation({
      projectId: 'proj-c',
      title: 'T',
      createdBy: 'Butter',
      participants: [{ name: 'Butter' }],
      initialMessage: { content: 'hi' },
      ...extra
    })).id
  }

  it('explicit sessionId: sets ownerSessionId + creates link row', async () => {
    const session = await svc.startSession({ projectId: 'proj-c' })
    const convId = await openConv({ sessionId: session.session.id })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (svc as any).db as import('better-sqlite3').Database
    const row = db
      .prepare('SELECT owner_session_id FROM conversations WHERE id = ?')
      .get(convId) as { owner_session_id: string | null }
    expect(row.owner_session_id).toBe(session.session.id)

    const links = await svc.findConversationsByLink('session', session.session.id)
    expect(links.some((c) => c.id === convId)).toBe(true)
  })

  it('auto-detect: exactly 1 active session → auto-link', async () => {
    const session = await svc.startSession({ projectId: 'proj-c' })
    const convId = await openConv()

    const links = await svc.findConversationsByLink('session', session.session.id)
    expect(links.some((c) => c.id === convId)).toBe(true)
  })

  it('auto-detect: 0 active sessions → no link', async () => {
    const convId = await openConv()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (svc as any).db as import('better-sqlite3').Database
    const row = db
      .prepare('SELECT owner_session_id FROM conversations WHERE id = ?')
      .get(convId) as { owner_session_id: string | null }
    expect(row.owner_session_id).toBeNull()
  })

  it('auto-detect: N > 1 active sessions → no link', async () => {
    await svc.startSession({ projectId: 'proj-c', workspaceId: 'ws-1' })
    await svc.startSession({ projectId: 'proj-c', workspaceId: 'ws-2' })
    const convId = await openConv()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (svc as any).db as import('better-sqlite3').Database
    const row = db
      .prepare('SELECT owner_session_id FROM conversations WHERE id = ?')
      .get(convId) as { owner_session_id: string | null }
    expect(row.owner_session_id).toBeNull()
  })

  it('explicit sessionId cross-project → throws', async () => {
    await svc.ensureProject('proj-other', 'Other', '/tmp/o')
    const session = await svc.startSession({ projectId: 'proj-other' })
    await expect(openConv({ sessionId: session.session.id })).rejects.toThrow(/belongs to project/)
  })

  it('explicit sessionId non-existent → throws', async () => {
    await expect(openConv({ sessionId: 'SESSION-NOPE' })).rejects.toThrow(/not found/)
  })
})

describe('decideConversation', () => {
  it('solo conversation (no extra participants beyond decider): flips to decided immediately', async () => {
    const id = await openFresh()
    const r = await svc.decideConversation(id, { author: 'Butter', decision: 'go left' })

    // Butter is the only participant and they own the decision — for the
    // single-participant case the consensus check is trivially satisfied as
    // soon as they signoff. Without an explicit signoff yet, status stays open.
    expect(r.conversation.status).toBe('open')
    expect(r.conversation.decisionSummary).toBe('go left')
    expect(r.actions).toHaveLength(0)
    const msgs = await svc.getConversationMessages(id)
    expect(msgs.at(-1)?.content).toBe('go left')
  })

  it('zero registered participants: flips to decided immediately (no consensus needed)', async () => {
    // Use createConversation directly to skip participant registration.
    const conv = await svc.createConversation({
      projectId: 'proj-c',
      title: 'no-participants',
      createdBy: 'Butter'
    })
    const r = await svc.decideConversation(conv.id, { author: 'Butter', decision: 'unilateral' })
    expect(r.conversation.status).toBe('decided')
    expect(r.conversation.decidedAt).not.toBeNull()
  })

  it('multi-participant: stays open until everyone signs off', async () => {
    const conv = await svc.openConversation({
      projectId: 'proj-c',
      title: 'consensus needed',
      createdBy: 'Butter',
      participants: [{ name: 'Butter' }, { name: 'Claude' }],
      initialMessage: { content: 'pick one' }
    })
    const r = await svc.decideConversation(conv.id, { author: 'Butter', decision: 'opt A' })
    expect(r.conversation.status).toBe('open')
    expect(r.conversation.decisionSummary).toBe('opt A')

    await svc.signoffConversation(conv.id, 'Butter')
    expect((await svc.getConversation(conv.id))?.status).toBe('open')

    const r2 = await svc.signoffConversation(conv.id, 'Claude')
    expect(r2.decided).toBe(true)
    expect(r2.conversation.status).toBe('decided')
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
    await expect(svc.decideConversation('CONV-999', { author: 'x', decision: 'y' })).rejects.toThrow(
      ConversationNotFoundError
    )
  })

  it('TASK-680: stores 5_000-char decision byte-for-byte (raw, no sanitization)', async () => {
    const id = await openFresh()
    const paragraph = [
      'Decision payload with every formerly-truncating pattern.',
      'Generics Promise<T>, comparisons (i < 5), HTML </section>, partial </res, </inv.',
      '```ts',
      'const x: Promise<T> = doThing()',
      'if (x < 5) return </close>',
      '<function_calls><invoke name="x"><parameter name="y">z</parameter></invoke></function_calls>',
      '```',
      'Stored raw — no application-side mutation at MCP boundary.'
    ].join('\n')
    const decision = (paragraph + '\n\n').repeat(20).slice(0, 5_000)
    expect(decision.length).toBe(5_000)

    const r = await svc.decideConversation(id, { author: 'Butter', decision })

    expect(r.conversation.decisionSummary).toBe(decision)
    const msgs = await svc.getConversationMessages(id)
    expect(msgs.at(-1)?.content).toBe(decision)
  })
})

describe('signoffConversation', () => {
  it('idempotent — calling twice with same name returns same signedOff[]', async () => {
    const id = await openFresh()
    const r1 = await svc.signoffConversation(id, 'Butter')
    expect(r1.signedOff).toEqual(['Butter'])
    const r2 = await svc.signoffConversation(id, 'Butter')
    expect(r2.signedOff).toEqual(['Butter'])
  })

  it('throws ConversationNotFoundError on missing id', async () => {
    await expect(svc.signoffConversation('CONV-999', 'Butter')).rejects.toThrow(
      ConversationNotFoundError
    )
  })

  it('does NOT flip status if no decisionSummary yet', async () => {
    const id = await openFresh()
    const r = await svc.signoffConversation(id, 'Butter')
    expect(r.conversation.status).toBe('open')
    expect(r.decided).toBe(false)
  })
})

describe('transaction rollback (atomicity)', () => {
  it('rolls back conv creation when link fails mid-open', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lifecycle = (svc as any).conversationLifecycle
    const orig = lifecycle.conversations.link.bind(lifecycle.conversations)
    lifecycle.conversations.link = () => {
      throw new Error('simulated link failure')
    }

    const task = await svc.createTask({ projectId: 'proj-c', title: 'A' })
    await expect(svc.openConversation({
        projectId: 'proj-c',
        title: 'rollback',
        createdBy: 'Butter',
        participants: [{ name: 'Butter' }],
        linkedTasks: [task.id],
        initialMessage: { content: 'hi' }
      })).rejects.toThrow('simulated link failure')

    lifecycle.conversations.link = orig

    const convs = await svc.findConversations('proj-c')
    expect(convs).toHaveLength(0)
  })

  it('rolls back status flip + decision message when action insert fails mid-decide', async () => {
    // Use a no-participants conv so decideConversation actually flips status,
    // exposing the rollback when actions[] fails.
    const conv = await svc.createConversation({
      projectId: 'proj-c',
      title: 'rollback decide',
      createdBy: 'Butter'
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lifecycle = (svc as any).conversationLifecycle
    const orig = lifecycle.conversations.addAction.bind(lifecycle.conversations)
    lifecycle.conversations.addAction = () => {
      throw new Error('simulated action failure')
    }

    await expect(svc.decideConversation(conv.id, {
        author: 'Butter',
        decision: 'should rollback',
        actions: [{ assignee: 'Claude', description: 'x' }]
      })).rejects.toThrow('simulated action failure')

    lifecycle.conversations.addAction = orig

    const final = await svc.getConversation(conv.id)
    expect(final?.status).toBe('open')
    expect(final?.decisionSummary).toBeNull()
    const msgs = await svc.getConversationMessages(conv.id)
    expect(msgs).toHaveLength(0)
  })
})
