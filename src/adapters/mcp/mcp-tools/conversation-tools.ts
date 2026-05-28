import type { InstrumentedServer } from '../instrumented-server'
import { z } from 'zod'
import { textResponse } from './types'
import { now } from '../../../core/domain/repositories/shared'
import {
  ConversationNotFoundError,
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

const conversationStatusSchema = z.enum(['open', 'decided'])
const priorityEnum = z.enum(['critical', 'high', 'medium', 'low'])

// TASK-972 Phase 2 — Zod cap replaces the prose advisory. Long convergence
// summaries belong in decisionSummary via conversation_decide.
const CONTENT_MAX = 1500
const contentSchema = z
  .string()
  .min(1)
  .max(
    CONTENT_MAX,
    `content exceeds ${CONTENT_MAX}-char cap — long convergence summaries belong in decisionSummary via conversation_decide`
  )

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
  return status === 'open'
}

export type ReadConversationDeps = Pick<
  ConversationOperations,
  | 'getConversation'
  | 'getConversationParticipants'
  | 'getConversationMessages'
  | 'getConversationActions'
  | 'getConversationLinks'
  | 'markConversationMessageRead'
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
  conversationId: string,
  options?: { as?: string }
): Promise<ConversationReadResponse | null> {
  const conv = await svc.getConversation(conversationId)
  if (!conv) return null

  const as = options?.as
  if (as) {
    const messages = await svc.getConversationMessages(conversationId)
    for (const m of messages) {
      if (!m.readBy.includes(as)) await svc.markConversationMessageRead(m.id, as)
    }
  }

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
          .array(z.object({ name: z.string() }))
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
          .object({ content: contentSchema })
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
        'Add a message to an existing conversation. Free-text content only — capped at 1500 chars. Long convergence summaries belong in decisionSummary via conversation_decide.',
      inputSchema: {
        conversationId: z.string(),
        author: z.string().describe('Participant name'),
        content: contentSchema
      }
    },
    async ({ conversationId, author, content }) =>
      tryLifecycle(async () => {
        const conv = await svc.getConversation(conversationId)
        if (!conv) throw new ConversationNotFoundError(conversationId)
        return svc.addConversationMessage({
          conversationId,
          authorName: author,
          content
        })
      })
  )

  server.registerTool(
    'conversation_decide',
    {
      description:
        'Record the decision on a conversation, optionally creating actions (which can spawn tasks). Status flips to `decided` only when every participant has signed off (or there are no registered participants). Otherwise the decisionSummary is recorded and status stays `open` until consensus.',
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
          signedOff: r.conversation.signedOff,
          decidedAt: r.conversation.decidedAt,
          actions: r.actions
        }
      })
  )

  server.registerTool(
    'conversation_signoff',
    {
      description:
        'Sign off on a conversation as the named participant. Idempotent — re-calling with the same name is a no-op. Flips status to `decided` only when every participant has signed off AND a decisionSummary already exists.',
      inputSchema: {
        conversationId: z.string(),
        name: z.string().describe('Participant name signing off')
      }
    },
    async ({ conversationId, name }) =>
      tryLifecycle(async () => {
        const r = await svc.signoffConversation(conversationId, name)
        return {
          conversationId,
          status: r.conversation.status,
          signedOff: r.signedOff,
          decided: r.decided
        }
      })
  )

  server.registerTool(
    'conversation_mark_read',
    {
      description:
        'Mark a specific message in a conversation as read by the named participant. Idempotent.',
      inputSchema: {
        conversationId: z.string(),
        messageId: z.string(),
        name: z.string().describe('Participant name marking the message read')
      }
    },
    async ({ conversationId, messageId, name }) =>
      tryLifecycle(async () => {
        const conv = await svc.getConversation(conversationId)
        if (!conv) throw new ConversationNotFoundError(conversationId)
        await svc.markConversationMessageRead(messageId, name)
        return { conversationId, messageId, name }
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
        'Poll for new messages in open conversations since a given timestamp. Use to detect messages added from other sessions.',
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
      const open = await svc.findConversations(projectId, 'open')
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
        'Read a full conversation thread: participants, messages (with readBy), decision, actions, links. Pass `as` to auto-mark every returned message as read by that participant.',
      inputSchema: {
        conversationId: z.string(),
        as: z
          .string()
          .optional()
          .describe('Participant name. When set, every returned message is marked read by this name.')
      }
    },
    async ({ conversationId, as }) => {
      const result = await readConversation(svc, conversationId, { as })
      if (!result) return textResponse(`Conversation ${conversationId} not found`)
      return textResponse(result)
    }
  )
}
