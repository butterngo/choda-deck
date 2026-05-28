import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import {
  readConversation,
  shouldInjectConversationEtiquette,
  type ReadConversationDeps
} from '../conversation-tools'
import { SqliteTaskService } from '../../../../core/domain/sqlite-task-service'
import type {
  Conversation,
  ConversationStatus,
  ConversationMessage
} from '../../../../core/domain/task-types'

const TEST_DB = path.join(__dirname, '__test-conversation-tools__.db')

describe('shouldInjectConversationEtiquette', () => {
  it('returns true for status=open (etiquette injected)', () => {
    expect(shouldInjectConversationEtiquette('open')).toBe(true)
  })

  it('returns false for status=decided (terminal — etiquette skipped)', () => {
    expect(shouldInjectConversationEtiquette('decided')).toBe(false)
  })

  it('returns false for unknown status (defensive default)', () => {
    expect(shouldInjectConversationEtiquette('unknown')).toBe(false)
  })
})

describe('readConversation (fakes)', () => {
  function makeFakeSvc(
    conv: Conversation | null,
    opts?: {
      messages?: ConversationMessage[]
      markRead?: (messageId: string, name: string) => void
    }
  ): ReadConversationDeps {
    const messages = opts?.messages ?? []
    return {
      getConversation: async () => conv,
      getConversationParticipants: async () => [],
      getConversationMessages: async () => messages,
      getConversationActions: async () => [],
      getConversationLinks: async () => [],
      markConversationMessageRead: async (messageId, name) => {
        opts?.markRead?.(messageId, name)
        const m = messages.find((mm) => mm.id === messageId)
        if (m && !m.readBy.includes(name)) m.readBy.push(name)
      }
    }
  }

  function makeConv(status: ConversationStatus, overrides?: Partial<Conversation>): Conversation {
    return {
      id: 'CONV-test-1',
      projectId: 'choda-deck',
      title: 'fake test conv',
      status,
      createdBy: 'butter',
      decisionSummary: null,
      signedOff: [],
      createdAt: '2026-05-09 00:00:00',
      decidedAt: null,
      ...overrides
    }
  }

  it('injects etiquette into payload when status=open', async () => {
    const svc = makeFakeSvc(makeConv('open'))
    const result = await readConversation(svc, 'CONV-test-1')
    expect(result).not.toBeNull()
    expect(result?.etiquette).toBeTruthy()
    // New 5-bullet text references readBy + signoff + propose_rewrite mechanics.
    expect(result?.etiquette).toMatch(/readBy/)
    expect(result?.etiquette).toMatch(/signoff/)
  })

  it('returns etiquette: null when status=decided', async () => {
    const svc = makeFakeSvc(makeConv('decided'))
    const result = await readConversation(svc, 'CONV-test-1')
    expect(result?.etiquette).toBeNull()
  })

  it('returns null when conversation not found', async () => {
    const svc = makeFakeSvc(null)
    const result = await readConversation(svc, 'CONV-missing')
    expect(result).toBeNull()
  })

  it('preserves conversation fields and attaches related collections', async () => {
    const svc = makeFakeSvc(makeConv('open', { title: 'preserved' }))
    const result = await readConversation(svc, 'CONV-test-1')
    expect(result?.id).toBe('CONV-test-1')
    expect(result?.title).toBe('preserved')
    expect(result?.signedOff).toEqual([])
    expect(result?.messages).toEqual([])
    expect(result?.participants).toEqual([])
  })

  it('auto-marks messages as read when `as` is provided', async () => {
    const markCalls: Array<[string, string]> = []
    const messages: ConversationMessage[] = [
      {
        id: 'MSG-1',
        conversationId: 'CONV-test-1',
        authorName: 'butter',
        content: 'first',
        readBy: [],
        createdAt: '2026-05-09 00:00:00'
      },
      {
        id: 'MSG-2',
        conversationId: 'CONV-test-1',
        authorName: 'claude',
        content: 'second',
        readBy: [],
        createdAt: '2026-05-09 00:00:01'
      }
    ]
    const svc = makeFakeSvc(makeConv('open'), {
      messages,
      markRead: (id, name) => markCalls.push([id, name])
    })
    const result = await readConversation(svc, 'CONV-test-1', { as: 'claude_desktop' })
    expect(markCalls).toEqual([
      ['MSG-1', 'claude_desktop'],
      ['MSG-2', 'claude_desktop']
    ])
    expect(result?.messages.every((m) => m.readBy.includes('claude_desktop'))).toBe(true)
  })

  it('does not call markRead when `as` is omitted (read-only)', async () => {
    const markCalls: Array<[string, string]> = []
    const svc = makeFakeSvc(makeConv('open'), {
      messages: [
        {
          id: 'MSG-1',
          conversationId: 'CONV-test-1',
          authorName: 'butter',
          content: 'x',
          readBy: [],
          createdAt: '2026-05-09 00:00:00'
        }
      ],
      markRead: (id, name) => markCalls.push([id, name])
    })
    await readConversation(svc, 'CONV-test-1')
    expect(markCalls).toEqual([])
  })

  it('skips re-marking when the participant is already in readBy (idempotent)', async () => {
    const markCalls: Array<[string, string]> = []
    const svc = makeFakeSvc(makeConv('open'), {
      messages: [
        {
          id: 'MSG-1',
          conversationId: 'CONV-test-1',
          authorName: 'butter',
          content: 'x',
          readBy: ['claude_desktop'],
          createdAt: '2026-05-09 00:00:00'
        }
      ],
      markRead: (id, name) => markCalls.push([id, name])
    })
    await readConversation(svc, 'CONV-test-1', { as: 'claude_desktop' })
    expect(markCalls).toEqual([])
  })
})

describe('repo-backed signoff + markMessageRead (real SqliteTaskService)', () => {
  let svc: SqliteTaskService

  beforeEach(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
    svc = new SqliteTaskService(TEST_DB)
    await svc.ensureProject('proj-conv', 'Conversation tools project', '/tmp/conv')
  })

  afterEach(async () => {
    await svc.close()
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  })

  it('appends signoff names + is idempotent on repeat', async () => {
    const conv = await svc.openConversation({
      projectId: 'proj-conv',
      title: 'sign me',
      createdBy: 'Butter',
      participants: [{ name: 'Butter' }, { name: 'Claude' }],
      initialMessage: { content: 'q' }
    })
    const r1 = await svc.signoffConversation(conv.id, 'Butter')
    expect(r1.signedOff).toEqual(['Butter'])
    const r2 = await svc.signoffConversation(conv.id, 'Butter')
    expect(r2.signedOff).toEqual(['Butter'])
    expect((await svc.getConversation(conv.id))?.signedOff).toEqual(['Butter'])
  })

  it('markMessageRead is idempotent — re-call does not error or duplicate', async () => {
    const conv = await svc.openConversation({
      projectId: 'proj-conv',
      title: 'read me',
      createdBy: 'Butter',
      participants: [{ name: 'Butter' }],
      initialMessage: { content: 'first' }
    })
    const msgs = await svc.getConversationMessages(conv.id)
    expect(msgs.length).toBe(1)
    const messageId = msgs[0].id
    await svc.markConversationMessageRead(messageId, 'Claude')
    await svc.markConversationMessageRead(messageId, 'Claude')
    const after = await svc.getConversationMessages(conv.id)
    expect(after[0].readBy).toEqual(['Claude'])
  })

  it('historical conversations render with signedOff: [] + readBy: [] (Phase-1 backfill smoke)', async () => {
    const conv = await svc.openConversation({
      projectId: 'proj-conv',
      title: 'historical',
      createdBy: 'Butter',
      participants: [{ name: 'Butter' }],
      initialMessage: { content: 'seed' }
    })
    const list = await svc.findConversations('proj-conv')
    const c = list.find((x) => x.id === conv.id)!
    expect(c.signedOff).toEqual([])
    const msgs = await svc.getConversationMessages(conv.id)
    expect(msgs.every((m) => m.readBy.length === 0)).toBe(true)
  })
})
