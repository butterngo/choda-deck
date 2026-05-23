import type { InstrumentedServer } from '../instrumented-server'
import { z } from 'zod'
import { textResponse } from './types'
import { now } from '../../../core/domain/repositories/shared'
import {
  ConversationAddSchemaError,
  ConversationNotFoundError,
  ConversationStatusError,
  LifecycleError
} from '../../../core/domain/lifecycle/errors'
import type { ConversationOperations } from '../../../core/domain/interfaces/conversation-repository.interface'
import type { ConversationLifecycleOperations } from '../../../core/domain/interfaces/conversation-lifecycle.interface'
import { loadMcpRules } from '../rules/mcp-rules-loader'
import type {
  Conversation,
  ConversationParticipant,
  ConversationMessage,
  ConversationAction,
  ConversationLink
} from '../../../core/domain/task-types'

export type ConversationToolsDeps = ConversationOperations & ConversationLifecycleOperations

const participantTypeSchema = z.enum(['human', 'agent', 'role'])
const messageTypeSchema = z.enum([
  'question',
  'answer',
  'proposal',
  'review',
  'decision',
  'action',
  'comment'
])

export const conversationAddMessageTypeSchema = messageTypeSchema.refine(
  (t) => t !== 'decision',
  { message: "use conversation_decide for decision messages — conversation_add doesn't accept type='decision'" }
)
const conversationStatusSchema = z.enum(['open', 'discussing', 'decided', 'closed', 'stale'])
const priorityEnum = z.enum(['critical', 'high', 'medium', 'low'])

export const reviewVerdictSchema = z.enum([
  'approve',
  'reject',
  'need-clarification',
  'defer'
])

export const reviewerFieldsSchema = z.object({
  verdict: reviewVerdictSchema,
  topConcern: z.string().min(20).max(200),
  asks: z.array(z.string().min(10).max(120)).min(1).max(5),
  notes: z.string().max(600).optional()
})

export type ReviewerFields = z.infer<typeof reviewerFieldsSchema>

export function composeReviewerContent(fields: ReviewerFields): string {
  const lines = [
    `VERDICT: ${fields.verdict}`,
    `TOP CONCERN: ${fields.topConcern}`,
    'SPECIFIC ASKS:',
    ...fields.asks.map((a) => `- ${a}`)
  ]
  if (fields.notes) {
    lines.push(`NOTES: ${fields.notes}`)
  }
  return lines.join('\n')
}

export interface ConversationAddContentInput {
  type: z.infer<typeof conversationAddMessageTypeSchema>
  content?: string
  verdict?: z.infer<typeof reviewVerdictSchema>
  topConcern?: string
  asks?: string[]
  notes?: string
}

// When type='review' the structured fields are required and the server composes
// the canonical content. For all other types, structured fields are rejected and
// the free-text `content` must be provided. Single source of truth for both rules.
export function resolveConversationAddContent(input: ConversationAddContentInput): string {
  const { type, content, verdict, topConcern, asks, notes } = input

  if (type === 'review') {
    const parsed = reviewerFieldsSchema.safeParse({ verdict, topConcern, asks, notes })
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ')
      throw new ConversationAddSchemaError(
        `type='review' requires structured fields (verdict, topConcern, asks[1..5], notes?) — ${issues}`
      )
    }
    return composeReviewerContent(parsed.data)
  }

  if (
    verdict !== undefined ||
    topConcern !== undefined ||
    asks !== undefined ||
    notes !== undefined
  ) {
    throw new ConversationAddSchemaError(
      `verdict/topConcern/asks/notes only valid for type='review' (got type='${type}')`
    )
  }
  if (content === undefined || content.length === 0) {
    throw new ConversationAddSchemaError(`content is required for type='${type}'`)
  }
  return content
}

const metadataSchema = z
  .object({
    codeChanges: z.array(z.string()).optional(),
    options: z
      .array(
        z.object({
          id: z.string(),
          description: z.string(),
          tradeoff: z.string()
        })
      )
      .optional(),
    selectedOption: z.string().optional()
  })
  .optional()

const actionInputSchema = z.object({
  assignee: z.string(),
  description: z.string(),
  spawnTask: z
    .object({
      title: z.string(),
      priority: priorityEnum.optional()
    })
    .optional()
})

async function tryLifecycle<T>(
  fn: () => T | Promise<T>
): Promise<ReturnType<typeof textResponse>> {
  try {
    return textResponse(await fn())
  } catch (e) {
    if (e instanceof LifecycleError) return textResponse(e.message)
    throw e
  }
}

export function shouldInjectConversationEtiquette(status: string): boolean {
  return status === 'open' || status === 'discussing'
}

export type ReadConversationDeps = Pick<
  ConversationOperations,
  | 'getConversation'
  | 'getConversationParticipants'
  | 'getConversationMessages'
  | 'getConversationActions'
  | 'getConversationLinks'
>

export interface ConversationReadResponse extends Conversation {
  participants: ConversationParticipant[]
  messages: ConversationMessage[]
  actions: ConversationAction[]
  links: ConversationLink[]
  etiquette: string | null
}

export async function readConversation(
  svc: ReadConversationDeps,
  conversationId: string
): Promise<ConversationReadResponse | null> {
  const conv = await svc.getConversation(conversationId)
  if (!conv) return null
  return {
    ...conv,
    participants: await svc.getConversationParticipants(conversationId),
    messages: await svc.getConversationMessages(conversationId),
    actions: await svc.getConversationActions(conversationId),
    links: await svc.getConversationLinks(conversationId),
    etiquette: shouldInjectConversationEtiquette(conv.status)
      ? loadMcpRules().conversationRead
      : null
  }
}

export const register = (server: InstrumentedServer, svc: ConversationToolsDeps): void => {
  server.registerTool(
    'conversation_open',
    {
      description:
        'Open a new conversation thread with participants, linked tasks, and an initial message',
      inputSchema: {
        projectId: z.string().describe('Project ID'),
        title: z.string().describe('Short decision-focused title'),
        createdBy: z.string().describe('Participant name of the initiator'),
        participants: z
          .array(
            z.object({
              name: z.string(),
              type: participantTypeSchema,
              role: z.string().optional()
            })
          )
          .describe('All participants (initiator included)'),
        linkedTasks: z
          .array(z.string())
          .optional()
          .describe('Task IDs this conversation relates to'),
        sessionId: z
          .string()
          .optional()
          .describe('Active session ID to link this conversation to. If omitted, auto-links when exactly one active session exists in the project.'),
        initialMessage: z
          .object({
            content: z.string(),
            type: z.enum(['question', 'proposal', 'review'])
          })
          .describe('Seed message that starts the discussion')
      }
    },
    async (input) =>
      tryLifecycle(async () => {
        const conv = await svc.openConversation(input)
        return {
          conversationId: conv.id,
          title: conv.title,
          status: conv.status,
          createdAt: conv.createdAt
        }
      })
  )

  server.registerTool(
    'conversation_add',
    {
      description:
        "Add a message to an existing conversation. For type='review', pass the structured fields (verdict, topConcern, asks, notes?) — the server composes the canonical content. Other types (question, answer, proposal, action, comment) use free-text content. type='decision' is rejected — use conversation_decide instead.",
      inputSchema: {
        conversationId: z.string(),
        author: z.string().describe('Participant name'),
        content: z
          .string()
          .optional()
          .describe(
            "Free-text content. Required for type ∈ {question, answer, proposal, action, comment}. Ignored for type='review' — use the structured fields instead."
          ),
        type: conversationAddMessageTypeSchema,
        metadata: metadataSchema,
        verdict: reviewVerdictSchema
          .optional()
          .describe("type='review' only — overall stance"),
        topConcern: z
          .string()
          .min(20)
          .max(200)
          .optional()
          .describe("type='review' only — single blocker, one sentence (20–200 chars)"),
        asks: z
          .array(z.string().min(10).max(120))
          .min(1)
          .max(5)
          .optional()
          .describe("type='review' only — 1–5 actionable items, each 10–120 chars"),
        notes: z
          .string()
          .max(600)
          .optional()
          .describe("type='review' only — optional escape hatch for counter-proposals (≤600 chars)")
      }
    },
    async ({ conversationId, author, content, type, verdict, topConcern, asks, notes }) =>
      tryLifecycle(async () => {
        const conv = await svc.getConversation(conversationId)
        if (!conv) throw new ConversationNotFoundError(conversationId)
        if (conv.status === 'closed') {
          throw new ConversationStatusError(
            conversationId,
            conv.status,
            'cannot add message to a closed conversation. Reopen it first.'
          )
        }
        const resolvedContent = resolveConversationAddContent({
          type,
          content,
          verdict,
          topConcern,
          asks,
          notes
        })
        const msg = await svc.addConversationMessage({
          conversationId,
          authorName: author,
          content: resolvedContent,
          messageType: type
        })
        if (conv.status === 'open' && type !== 'comment') {
          await svc.updateConversation(conversationId, { status: 'discussing' })
        }
        return msg
      })
  )

  server.registerTool(
    'conversation_decide',
    {
      description:
        'Record the decision on a conversation, optionally creating actions (which can spawn tasks). Side effects: status → decided, decision_summary set, actions + tasks written.',
      inputSchema: {
        conversationId: z.string(),
        author: z.string(),
        decision: z.string().describe('Decision summary'),
        actions: z.array(actionInputSchema).optional()
      }
    },
    async ({ conversationId, author, decision, actions }) =>
      tryLifecycle(async () => {
        const r = await svc.decideConversation(conversationId, { author, decision, actions })
        return {
          conversationId,
          status: r.conversation.status,
          decisionSummary: r.conversation.decisionSummary,
          decidedAt: r.conversation.decidedAt,
          actions: r.actions
        }
      })
  )

  server.registerTool(
    'conversation_close',
    {
      description: 'Close a decided conversation (status → closed).',
      inputSchema: { conversationId: z.string() }
    },
    async ({ conversationId }) =>
      tryLifecycle(async () => {
        const conv = await svc.closeConversation(conversationId)
        return { conversationId, status: conv.status }
      })
  )

  server.registerTool(
    'conversation_reopen',
    {
      description: 'Reopen a decided conversation back to discussing.',
      inputSchema: { conversationId: z.string() }
    },
    async ({ conversationId }) =>
      tryLifecycle(async () => {
        const conv = await svc.reopenConversation(conversationId)
        return { conversationId, status: conv.status }
      })
  )

  server.registerTool(
    'conversation_list',
    {
      description: 'List conversations for a project, optionally filtered by status or participant',
      inputSchema: {
        projectId: z.string(),
        status: conversationStatusSchema.or(z.literal('all')).optional(),
        participant: z
          .string()
          .optional()
          .describe('Filter to conversations this participant is in')
      }
    },
    async ({ projectId, status, participant }) => {
      const rawStatus = status === 'all' ? undefined : status
      const conversations = await svc.findConversations(projectId, rawStatus)

      let filtered: Conversation[]
      if (participant) {
        filtered = []
        for (const c of conversations) {
          const parts = await svc.getConversationParticipants(c.id)
          if (parts.some((p) => p.name === participant)) filtered.push(c)
        }
      } else {
        filtered = conversations
      }

      return textResponse(filtered)
    }
  )

  server.registerTool(
    'conversation_poll',
    {
      description:
        'Poll for new messages in open/discussing conversations since a given timestamp. Use to detect messages added from other sessions.',
      inputSchema: {
        projectId: z.string(),
        since: z
          .string()
          .optional()
          .describe(
            'ISO timestamp — only return messages after this. Omit to get latest message per conversation.'
          )
      }
    },
    async ({ projectId, since }) => {
      const open = [
        ...(await svc.findConversations(projectId, 'open')),
        ...(await svc.findConversations(projectId, 'discussing'))
      ]
      const sinceNorm = since ? since.replace('T', ' ').replace('Z', '') : ''
      const results: Array<{
        conversationId: string
        title: string
        status: Conversation['status']
        newMessages: ConversationMessage[]
      }> = []
      for (const c of open) {
        const messages = await svc.getConversationMessages(c.id)
        const filtered = sinceNorm
          ? messages.filter((m) => m.createdAt > sinceNorm)
          : messages.slice(-1)
        if (filtered.length > 0) {
          results.push({
            conversationId: c.id,
            title: c.title,
            status: c.status,
            newMessages: filtered
          })
        }
      }

      return textResponse({ checkedAt: now(), conversations: results })
    }
  )

  server.registerTool(
    'conversation_read',
    {
      description:
        'Read a full conversation thread: participants, messages, decision, actions, links',
      inputSchema: { conversationId: z.string() }
    },
    async ({ conversationId }) => {
      const result = await readConversation(svc, conversationId)
      if (!result) return textResponse(`Conversation ${conversationId} not found`)
      return textResponse(result)
    }
  )
}
