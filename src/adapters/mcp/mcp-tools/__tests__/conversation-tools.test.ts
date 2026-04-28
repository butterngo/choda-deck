import { describe, it, expect } from 'vitest'
import { conversationAddMessageTypeSchema } from '../conversation-tools'

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
