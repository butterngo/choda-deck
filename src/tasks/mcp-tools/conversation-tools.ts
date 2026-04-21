import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { textResponse } from './types'
import { now } from '../repositories/shared'
import { LifecycleError } from '../lifecycle/errors'
import type { ConversationOperations } from '../interfaces/conversation-repository.interface'
import type { ConversationLifecycleOperations } from '../interfaces/conversation-lifecycle.interface'

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
const conversationStatusSchema = z.enum(['open', 'discussing', 'decided', 'closed', 'stale'])
const priorityEnum = z.enum(['critical', 'high', 'medium', 'low'])

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

function tryLifecycle<T>(fn: () => T): ReturnType<typeof textResponse> {
  try {
    return textResponse(fn())
  } catch (e) {
    if (e instanceof LifecycleError) return textResponse(e.message)
    throw e
  }
}

export const register = (server: McpServer, svc: ConversationToolsDeps): void => {
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
      tryLifecycle(() => {
        const conv = svc.openConversation(input)
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
        'Add a message to an existing conversation (any type except decision — use conversation_decide for that)',
      inputSchema: {
        conversationId: z.string(),
        author: z.string().describe('Participant name'),
        content: z.string(),
        type: messageTypeSchema,
        metadata: metadataSchema
      }
    },
    async ({ conversationId, author, content, type, metadata }) => {
      const msg = svc.addConversationMessage({
        conversationId,
        authorName: author,
        content,
        messageType: type,
        metadata
      })
      const conv = svc.getConversation(conversationId)
      if (conv && conv.status === 'open' && type !== 'comment') {
        svc.updateConversation(conversationId, { status: 'discussing' })
      }
      return textResponse(msg)
    }
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
      tryLifecycle(() => {
        const r = svc.decideConversation(conversationId, { author, decision, actions })
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
      tryLifecycle(() => {
        const conv = svc.closeConversation(conversationId)
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
      tryLifecycle(() => {
        const conv = svc.reopenConversation(conversationId)
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
      const conversations = svc.findConversations(projectId, rawStatus)

      const filtered = participant
        ? conversations.filter((c) =>
            svc.getConversationParticipants(c.id).some((p) => p.name === participant)
          )
        : conversations

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
        ...svc.findConversations(projectId, 'open'),
        ...svc.findConversations(projectId, 'discussing')
      ]
      const results = open
        .map((c) => {
          const messages = svc.getConversationMessages(c.id)
          const sinceNorm = since ? since.replace('T', ' ').replace('Z', '') : ''
          const filtered = sinceNorm
            ? messages.filter((m) => m.createdAt > sinceNorm)
            : messages.slice(-1)
          return { conversationId: c.id, title: c.title, status: c.status, newMessages: filtered }
        })
        .filter((r) => r.newMessages.length > 0)

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
      const conv = svc.getConversation(conversationId)
      if (!conv) return textResponse(`Conversation ${conversationId} not found`)

      return textResponse({
        ...conv,
        participants: svc.getConversationParticipants(conversationId),
        messages: svc.getConversationMessages(conversationId),
        actions: svc.getConversationActions(conversationId),
        links: svc.getConversationLinks(conversationId)
      })
    }
  )
}
