import { describe, it, expect } from 'vitest'
import {
  conversationAddMessageTypeSchema,
  shouldInjectConversationEtiquette,
  readConversation,
  type ReadConversationDeps
} from '../conversation-tools'
import type { Conversation, ConversationStatus } from '../../../../core/domain/task-types'

describe('conversationAddMessageTypeSchema', () => {
  it("rejects type='decision' with a message pointing to conversation_decide", () => {
    const result = conversationAddMessageTypeSchema.safeParse('decision')
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/conversation_decide/)
    }
  })

  it.each(['question', 'answer', 'proposal', 'review', 'action', 'comment'] as const)(
    "accepts type='%s'",
    (type) => {
      const result = conversationAddMessageTypeSchema.safeParse(type)
      expect(result.success).toBe(true)
    }
  )

  it('rejects unknown types with the underlying enum error', () => {
    const result = conversationAddMessageTypeSchema.safeParse('foo')
    expect(result.success).toBe(false)
  })
})

describe('shouldInjectConversationEtiquette', () => {
  it.each(['open', 'discussing'] as const)(
    'returns true for active status=%s — etiquette injected',
    (status) => {
      expect(shouldInjectConversationEtiquette(status)).toBe(true)
    }
  )

  it.each(['decided', 'closed', 'stale'] as const)(
    'returns false for terminal status=%s — etiquette skipped',
    (status) => {
      expect(shouldInjectConversationEtiquette(status)).toBe(false)
    }
  )

  it('returns false for unknown status (defensive default)', () => {
    expect(shouldInjectConversationEtiquette('unknown')).toBe(false)
  })
})

describe('readConversation', () => {
  function makeFakeSvc(conv: Conversation | null): ReadConversationDeps {
    return {
      getConversation: () => conv,
      getConversationParticipants: () => [],
      getConversationMessages: () => [],
      getConversationActions: () => [],
      getConversationLinks: () => []
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
      createdAt: '2026-05-09 00:00:00',
      decidedAt: null,
      closedAt: null,
      ...overrides
    }
  }

  it.each(['open', 'discussing'] as const)(
    'injects etiquette into payload when status=%s',
    (status) => {
      const svc = makeFakeSvc(makeConv(status))
      const result = readConversation(svc, 'CONV-test-1')
      expect(result).not.toBeNull()
      expect(result?.etiquette).toBeTruthy()
      expect(result?.etiquette).toMatch(/Discussion etiquette/)
    }
  )

  it.each(['decided', 'closed', 'stale'] as const)(
    'returns etiquette: null when status=%s',
    (status) => {
      const svc = makeFakeSvc(makeConv(status))
      const result = readConversation(svc, 'CONV-test-1')
      expect(result).not.toBeNull()
      expect(result?.etiquette).toBeNull()
    }
  )

  it('returns null when conversation not found', () => {
    const svc = makeFakeSvc(null)
    const result = readConversation(svc, 'CONV-missing')
    expect(result).toBeNull()
  })

  it('preserves conversation fields and attaches related collections', () => {
    const svc = makeFakeSvc(makeConv('open', { title: 'preserved' }))
    const result = readConversation(svc, 'CONV-test-1')
    expect(result?.id).toBe('CONV-test-1')
    expect(result?.title).toBe('preserved')
    expect(result?.participants).toEqual([])
    expect(result?.messages).toEqual([])
    expect(result?.actions).toEqual([])
    expect(result?.links).toEqual([])
  })
})
