import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { SqliteTaskService } from '../sqlite-task-service'
import { ConversationNotFoundError, ConversationStatusError } from './errors'

const TEST_DB = path.join(__dirname, '__test-conversation-lifecycle__.db')
let svc: SqliteTaskService

function openFresh(title = 'T'): string {
  const conv = svc.openConversation({
    projectId: 'proj-c',
    title,
    createdBy: 'Butter',
    participants: [{ name: 'Butter', type: 'human' }],
    initialMessage: { content: 'seed', type: 'question' }
  })
  return conv.id
}

beforeEach(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  svc = new SqliteTaskService(TEST_DB)
  svc.ensureProject('proj-c', 'Conversation Project', '/tmp/c')
})

afterEach(() => {
  svc.close()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
})

describe('openConversation', () => {
  it('happy path: creates conv + seeds initial message', () => {
    const conv = svc.openConversation({
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
    const messages = svc.getConversationMessages(conv.id)
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toBe('How should we do auth?')
    expect(messages[0].messageType).toBe('question')
  })

  it('links to tasks when linkedTasks provided', () => {
    const task = svc.createTask({ projectId: 'proj-c', title: 'A' })
    const conv = svc.openConversation({
      projectId: 'proj-c',
      title: 'T',
      createdBy: 'Butter',
      participants: [{ name: 'Butter', type: 'human' }],
      linkedTasks: [task.id],
      initialMessage: { content: 'hi', type: 'question' }
    })
    const links = svc.getConversationLinks(conv.id)
    expect(links).toHaveLength(1)
    expect(links[0].linkedId).toBe(task.id)
  })

  it('allows N parallel open conversations per project', () => {
    const id1 = openFresh('first')
    const id2 = openFresh('second')
    const id3 = openFresh('third')

    const open = svc.findConversations('proj-c', 'open')
    expect(open.map((c) => c.id).sort()).toEqual([id1, id2, id3].sort())
  })

  it('allows opening new conv while another is decided but not closed', () => {
    const id1 = openFresh('first')
    svc.decideConversation(id1, { author: 'Butter', decision: 'yes' })
    const id2 = openFresh('second')
    expect(svc.getConversation(id2)?.status).toBe('open')
  })
})

describe('openConversation R3 ownership tag', () => {
  it('tags conv with owner_type=interactive', () => {
    const conv = svc.openConversation({
      projectId: 'proj-c',
      title: 'Interactive',
      createdBy: 'Butter',
      participants: [{ name: 'Butter', type: 'human' }],
      initialMessage: { content: 'hi', type: 'question' }
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
  function openConv(extra?: { sessionId?: string }): string {
    return svc.openConversation({
      projectId: 'proj-c',
      title: 'T',
      createdBy: 'Butter',
      participants: [{ name: 'Butter', type: 'human' }],
      initialMessage: { content: 'hi', type: 'question' },
      ...extra
    }).id
  }

  it('explicit sessionId: sets ownerSessionId + creates link row', () => {
    const session = svc.startSession({ projectId: 'proj-c' })
    const convId = openConv({ sessionId: session.session.id })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (svc as any).db as import('better-sqlite3').Database
    const row = db
      .prepare('SELECT owner_session_id FROM conversations WHERE id = ?')
      .get(convId) as { owner_session_id: string | null }
    expect(row.owner_session_id).toBe(session.session.id)

    const links = svc.findConversationsByLink('session', session.session.id)
    expect(links.some((c) => c.id === convId)).toBe(true)
  })

  it('auto-detect: exactly 1 active session → auto-link', () => {
    const session = svc.startSession({ projectId: 'proj-c' })
    const convId = openConv()

    const links = svc.findConversationsByLink('session', session.session.id)
    // auto-conv from startSession + our new conv
    expect(links.some((c) => c.id === convId)).toBe(true)
  })

  it('auto-detect: 0 active sessions → no link', () => {
    const convId = openConv()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (svc as any).db as import('better-sqlite3').Database
    const row = db
      .prepare('SELECT owner_session_id FROM conversations WHERE id = ?')
      .get(convId) as { owner_session_id: string | null }
    expect(row.owner_session_id).toBeNull()
  })

  it('auto-detect: N > 1 active sessions → no link', () => {
    svc.startSession({ projectId: 'proj-c', workspaceId: 'ws-1' })
    svc.startSession({ projectId: 'proj-c', workspaceId: 'ws-2' })
    const convId = openConv()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (svc as any).db as import('better-sqlite3').Database
    const row = db
      .prepare('SELECT owner_session_id FROM conversations WHERE id = ?')
      .get(convId) as { owner_session_id: string | null }
    expect(row.owner_session_id).toBeNull()
  })

  it('explicit sessionId cross-project → throws', () => {
    svc.ensureProject('proj-other', 'Other', '/tmp/o')
    const session = svc.startSession({ projectId: 'proj-other' })
    expect(() => openConv({ sessionId: session.session.id })).toThrow(/belongs to project/)
  })

  it('explicit sessionId non-existent → throws', () => {
    expect(() => openConv({ sessionId: 'SESSION-NOPE' })).toThrow(/not found/)
  })
})

describe('decideConversation', () => {
  it('happy path: adds decision message + flips to decided', () => {
    const id = openFresh()
    const r = svc.decideConversation(id, { author: 'Butter', decision: 'go left' })

    expect(r.conversation.status).toBe('decided')
    expect(r.conversation.decisionSummary).toBe('go left')
    expect(r.actions).toHaveLength(0)
    const msgs = svc.getConversationMessages(id)
    expect(msgs.at(-1)?.messageType).toBe('decision')
    expect(msgs.at(-1)?.content).toBe('go left')
  })

  it('spawns tasks for actions that include spawnTask', () => {
    const id = openFresh()
    const r = svc.decideConversation(id, {
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

    const links = svc.getConversationLinks(id)
    expect(links.some((l) => l.linkedId === r.actions[0].linkedTaskId)).toBe(true)
  })

  it('throws ConversationNotFoundError on missing id', () => {
    expect(() => svc.decideConversation('CONV-999', { author: 'x', decision: 'y' })).toThrowError(
      ConversationNotFoundError
    )
  })
})

describe('closeConversation', () => {
  it('happy path: decided → closed', () => {
    const id = openFresh()
    svc.decideConversation(id, { author: 'Butter', decision: 'go' })
    const conv = svc.closeConversation(id)

    expect(conv.status).toBe('closed')
    expect(conv.closedAt).not.toBeNull()
  })

  it('throws ConversationNotFoundError on missing id', () => {
    expect(() => svc.closeConversation('CONV-999')).toThrowError(ConversationNotFoundError)
  })

  it('throws ConversationStatusError when not decided', () => {
    const id = openFresh()
    expect(() => svc.closeConversation(id)).toThrowError(ConversationStatusError)
  })
})

describe('reopenConversation', () => {
  it('happy path: decided → discussing', () => {
    const id = openFresh()
    svc.decideConversation(id, { author: 'Butter', decision: 'go' })
    const conv = svc.reopenConversation(id)
    expect(conv.status).toBe('discussing')
  })

  it('allows reopen even when another conversation is active', () => {
    const id1 = openFresh('first')
    svc.decideConversation(id1, { author: 'Butter', decision: 'go' })
    openFresh('second') // another open conv exists

    const conv = svc.reopenConversation(id1)
    expect(conv.status).toBe('discussing')
  })

  it('throws ConversationNotFoundError on missing id', () => {
    expect(() => svc.reopenConversation('CONV-999')).toThrowError(ConversationNotFoundError)
  })

  it('throws ConversationStatusError when status is open', () => {
    const id = openFresh()
    expect(() => svc.reopenConversation(id)).toThrowError(ConversationStatusError)
  })
})

describe('transaction rollback (atomicity)', () => {
  it('rolls back conv creation when link fails mid-open', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lifecycle = (svc as any).conversationLifecycle
    const orig = lifecycle.conversations.link.bind(lifecycle.conversations)
    lifecycle.conversations.link = () => {
      throw new Error('simulated link failure')
    }

    const task = svc.createTask({ projectId: 'proj-c', title: 'A' })
    expect(() =>
      svc.openConversation({
        projectId: 'proj-c',
        title: 'rollback',
        createdBy: 'Butter',
        participants: [{ name: 'Butter', type: 'human' }],
        linkedTasks: [task.id],
        initialMessage: { content: 'hi', type: 'question' }
      })
    ).toThrow('simulated link failure')

    lifecycle.conversations.link = orig

    const convs = svc.findConversations('proj-c')
    expect(convs).toHaveLength(0)
  })

  it('rolls back status flip + decision message when action insert fails mid-decide', () => {
    const id = openFresh()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lifecycle = (svc as any).conversationLifecycle
    const orig = lifecycle.conversations.addAction.bind(lifecycle.conversations)
    lifecycle.conversations.addAction = () => {
      throw new Error('simulated action failure')
    }

    expect(() =>
      svc.decideConversation(id, {
        author: 'Butter',
        decision: 'should rollback',
        actions: [{ assignee: 'Claude', description: 'x' }]
      })
    ).toThrow('simulated action failure')

    lifecycle.conversations.addAction = orig

    const conv = svc.getConversation(id)
    expect(conv?.status).toBe('open')
    expect(conv?.decisionSummary).toBeNull()
    const msgs = svc.getConversationMessages(id)
    expect(msgs.some((m) => m.messageType === 'decision')).toBe(false)
  })
})
