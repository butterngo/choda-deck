import { z } from 'zod'
import { textResponse, type Register } from './types'
import { now } from '../repositories/shared'

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

export const register: Register = (server, svc) => {
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
        initialMessage: z
          .object({
            content: z.string(),
            type: z.enum(['question', 'proposal', 'review'])
          })
          .describe('Seed message that starts the discussion')
      }
    },
    async (input) => {
      const blocking = checkConversationGuards(svc, input.projectId)
      if (blocking) return textResponse(blocking)

      const conv = svc.createConversation({
        projectId: input.projectId,
        title: input.title,
        createdBy: input.createdBy,
        participants: input.participants
      })

      svc.addConversationMessage({
        conversationId: conv.id,
        authorName: input.createdBy,
        content: input.initialMessage.content,
        messageType: input.initialMessage.type
      })

      for (const taskId of input.linkedTasks ?? []) {
        svc.linkConversation(conv.id, 'task', taskId)
      }

      return textResponse({
        conversationId: conv.id,
        title: conv.title,
        status: conv.status,
        createdAt: conv.createdAt
      })
    }
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
    async ({ conversationId, author, decision, actions }) => {
      const conv = svc.getConversation(conversationId)
      if (!conv) return textResponse(`Conversation ${conversationId} not found`)

      svc.addConversationMessage({
        conversationId,
        authorName: author,
        content: decision,
        messageType: 'decision'
      })

      const decidedAt = now()
      svc.updateConversation(conversationId, {
        status: 'decided',
        decisionSummary: decision,
        decidedAt
      })

      const createdActions = (actions ?? []).map((action) =>
        createActionAndMaybeSpawnTask(svc, conv.projectId, conversationId, action)
      )

      return textResponse({
        conversationId,
        status: 'decided',
        decisionSummary: decision,
        decidedAt,
        actions: createdActions
      })
    }
  )

  server.registerTool(
    'conversation_close',
    {
      description:
        'Close a decided conversation (status → implemented). Must close all decided conversations before opening a new one.',
      inputSchema: { conversationId: z.string() }
    },
    async ({ conversationId }) => {
      const conv = svc.getConversation(conversationId)
      if (!conv) return textResponse(`Conversation ${conversationId} not found`)
      if (conv.status !== 'decided') {
        return textResponse(`Cannot close: status is ${conv.status}, must be decided first`)
      }
      svc.updateConversation(conversationId, { status: 'closed', closedAt: now() })
      return textResponse({ conversationId, status: 'closed' })
    }
  )

  server.registerTool(
    'conversation_reopen',
    {
      description:
        'Reopen a decided conversation back to discussing. Only works if no other conversation is currently open/discussing for this project.',
      inputSchema: { conversationId: z.string() }
    },
    async ({ conversationId }) => {
      const conv = svc.getConversation(conversationId)
      if (!conv) return textResponse(`Conversation ${conversationId} not found`)
      if (conv.status !== 'decided') {
        return textResponse(`Cannot reopen: status is ${conv.status}, must be decided`)
      }
      const active = [
        ...svc.findConversations(conv.projectId, 'open'),
        ...svc.findConversations(conv.projectId, 'discussing')
      ]
      if (active.length > 0) {
        return textResponse(`Cannot reopen: ${active[0].id} is already ${active[0].status}`)
      }
      svc.updateConversation(conversationId, { status: 'discussing' })
      return textResponse({ conversationId, status: 'discussing' })
    }
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

function checkConversationGuards(svc: Parameters<Register>[1], projectId: string): string | null {
  const discussing = [
    ...svc.findConversations(projectId, 'open'),
    ...svc.findConversations(projectId, 'discussing')
  ]
  if (discussing.length > 0) {
    return `Cannot open: ${discussing[0].id} "${discussing[0].title}" is ${discussing[0].status}. Finish it first.`
  }
  const decided = svc.findConversations(projectId, 'decided')
  if (decided.length > 0) {
    const ids = decided.map((c) => c.id).join(', ')
    return `Cannot open: ${decided.length} decided conversation(s) not closed yet (${ids}). Use conversation_close first.`
  }
  return null
}

type ActionInput = z.infer<typeof actionInputSchema>

function createActionAndMaybeSpawnTask(
  svc: Parameters<Register>[1],
  projectId: string,
  conversationId: string,
  action: ActionInput
): { id: string; assignee: string; description: string; linkedTaskId: string | null } {
  let linkedTaskId: string | undefined
  if (action.spawnTask) {
    const task = svc.createTask({
      projectId,
      title: action.spawnTask.title,
      priority: action.spawnTask.priority,
      labels: [`assignee:${action.assignee}`]
    })
    linkedTaskId = task.id
    svc.linkConversation(conversationId, 'task', task.id)
  }

  const created = svc.addConversationAction({
    conversationId,
    assignee: action.assignee,
    description: action.description,
    linkedTaskId
  })
  return {
    id: created.id,
    assignee: created.assignee,
    description: created.description,
    linkedTaskId: created.linkedTaskId
  }
}
