import { describe, it, expect } from 'vitest'
import {
  composeReviewerContent,
  conversationAddMessageTypeSchema,
  readConversation,
  resolveConversationAddContent,
  shouldInjectConversationEtiquette,
  type ReadConversationDeps,
  type ReviewerFields
} from '../conversation-tools'
import { ConversationAddSchemaError } from '../../../../core/domain/lifecycle/errors'
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
      getConversation: async () => conv,
      getConversationParticipants: async () => [],
      getConversationMessages: async () => [],
      getConversationActions: async () => [],
      getConversationLinks: async () => []
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
    async (status) => {
      const svc = makeFakeSvc(makeConv(status))
      const result = await readConversation(svc, 'CONV-test-1')
      expect(result).not.toBeNull()
      expect(result?.etiquette).toBeTruthy()
      expect(result?.etiquette).toMatch(/Discussion etiquette/)
    }
  )

  it.each(['decided', 'closed', 'stale'] as const)(
    'returns etiquette: null when status=%s',
    async (status) => {
      const svc = makeFakeSvc(makeConv(status))
      const result = await readConversation(svc, 'CONV-test-1')
      expect(result).not.toBeNull()
      expect(result?.etiquette).toBeNull()
    }
  )

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
    expect(result?.participants).toEqual([])
    expect(result?.messages).toEqual([])
    expect(result?.actions).toEqual([])
    expect(result?.links).toEqual([])
  })
})

describe('composeReviewerContent', () => {
  const baseFields: ReviewerFields = {
    verdict: 'reject',
    topConcern: 'Schema lives in prose only — Opus drifts because no tool gate enforces it.',
    asks: ['Add Zod fields for verdict/topConcern/asks', 'Compose content server-side']
  }

  it('renders the canonical 4-block layout without notes', () => {
    const out = composeReviewerContent(baseFields)
    expect(out).toBe(
      [
        'VERDICT: reject',
        'TOP CONCERN: Schema lives in prose only — Opus drifts because no tool gate enforces it.',
        'SPECIFIC ASKS:',
        '- Add Zod fields for verdict/topConcern/asks',
        '- Compose content server-side'
      ].join('\n')
    )
  })

  it('appends NOTES line when notes provided', () => {
    const out = composeReviewerContent({
      ...baseFields,
      notes: 'Keep content free-text for non-review types.'
    })
    expect(out).toMatch(/\nNOTES: Keep content free-text for non-review types\.$/)
  })
})

describe('resolveConversationAddContent', () => {
  const goodReview = {
    verdict: 'reject' as const,
    topConcern: 'Schema lives in prose only — Opus drifts because no tool gate enforces it.',
    asks: ['Add Zod fields for verdict/topConcern/asks', 'Compose content server-side']
  }

  it("composes canonical content for type='review' with structured fields", () => {
    const out = resolveConversationAddContent({ type: 'review', ...goodReview })
    expect(out).toMatch(/^VERDICT: reject\n/)
    expect(out).toMatch(/SPECIFIC ASKS:/)
  })

  it.each([
    ['verdict', { ...goodReview, verdict: undefined }],
    ['topConcern', { ...goodReview, topConcern: undefined }],
    ['asks', { ...goodReview, asks: undefined }]
  ])("rejects type='review' missing %s with a field-level error", (field, partial) => {
    expect(() => resolveConversationAddContent({ type: 'review', ...partial })).toThrow(
      ConversationAddSchemaError
    )
    try {
      resolveConversationAddContent({ type: 'review', ...partial })
    } catch (e) {
      expect((e as Error).message).toContain(field)
    }
  })

  it("rejects type='review' with asks.length === 6 (max 5)", () => {
    const asks = Array.from({ length: 6 }, (_, i) => `Ask number ${i} that is long enough`)
    expect(() =>
      resolveConversationAddContent({
        type: 'review',
        ...goodReview,
        asks
      })
    ).toThrow(ConversationAddSchemaError)
  })

  it("rejects type='review' with topConcern length === 201 (max 200)", () => {
    expect(() =>
      resolveConversationAddContent({
        type: 'review',
        ...goodReview,
        topConcern: 'x'.repeat(201)
      })
    ).toThrow(ConversationAddSchemaError)
  })

  it("rejects type='review' with topConcern length === 19 (min 20)", () => {
    expect(() =>
      resolveConversationAddContent({
        type: 'review',
        ...goodReview,
        topConcern: 'x'.repeat(19)
      })
    ).toThrow(ConversationAddSchemaError)
  })

  it("rejects type='review' with an ask shorter than 10 chars", () => {
    expect(() =>
      resolveConversationAddContent({
        type: 'review',
        ...goodReview,
        asks: ['too short']
      })
    ).toThrow(ConversationAddSchemaError)
  })

  it("rejects type='comment' with structured fields", () => {
    expect(() =>
      resolveConversationAddContent({
        type: 'comment',
        content: 'a normal comment',
        ...goodReview
      })
    ).toThrow(ConversationAddSchemaError)
  })

  it.each(['question', 'answer', 'proposal', 'action', 'comment'] as const)(
    "returns free-text content unchanged for type='%s'",
    (type) => {
      const out = resolveConversationAddContent({ type, content: 'plain free-text body' })
      expect(out).toBe('plain free-text body')
    }
  )

  it.each(['question', 'answer', 'proposal', 'action', 'comment'] as const)(
    "rejects type='%s' with empty/missing content",
    (type) => {
      expect(() => resolveConversationAddContent({ type, content: '' })).toThrow(
        ConversationAddSchemaError
      )
      expect(() => resolveConversationAddContent({ type })).toThrow(ConversationAddSchemaError)
    }
  )
})
