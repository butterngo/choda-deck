import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { textResponse } from './types'
import { LifecycleError } from '../lifecycle/errors'
import type { InboxOperations } from '../interfaces/inbox-repository.interface'
import type { ConversationOperations } from '../interfaces/conversation-repository.interface'
import type { InboxLifecycleOperations } from '../interfaces/inbox-lifecycle.interface'

export type InboxToolsDeps = InboxOperations & ConversationOperations & InboxLifecycleOperations

function tryLifecycle<T>(fn: () => T): ReturnType<typeof textResponse> {
  try {
    return textResponse(fn())
  } catch (e) {
    if (e instanceof LifecycleError) return textResponse(e.message)
    throw e
  }
}

export const register = (server: McpServer, svc: InboxToolsDeps): void => {
  server.registerTool(
    'inbox_add',
    {
      description: 'Add a raw idea to inbox. Returns INBOX-NNN with status=raw.',
      inputSchema: {
        projectId: z.string().describe('Project ID (required)'),
        content: z.string().describe('Raw idea content')
      }
    },
    async ({ projectId, content }) => textResponse(svc.createInbox({ projectId, content }))
  )

  server.registerTool(
    'inbox_update',
    {
      description:
        'Update inbox item content (text only, not status). Allowed in raw/researching/ready. Blocked in converted/archived to preserve trace.',
      inputSchema: {
        id: z.string().describe('Inbox item ID'),
        content: z.string().describe('New content text')
      }
    },
    async ({ id, content }) => {
      const item = svc.getInbox(id)
      if (!item) return textResponse(`Inbox ${id} not found`)
      if (item.status === 'converted' || item.status === 'archived') {
        return textResponse(
          `Inbox ${id} is ${item.status} — content locked to preserve trace history`
        )
      }
      return textResponse(svc.updateInbox(id, { content }))
    }
  )

  server.registerTool(
    'inbox_list',
    {
      description: 'List inbox items, filter by project and status',
      inputSchema: {
        projectId: z
          .string()
          .optional()
          .describe("Project ID. Use 'global' for items without a project."),
        status: z
          .enum(['raw', 'researching', 'ready', 'converted', 'archived'])
          .optional()
          .describe('Filter by status')
      }
    },
    async ({ projectId, status }) => {
      const filter: Parameters<typeof svc.findInbox>[0] = {}
      if (projectId === 'global') filter.projectId = null
      else if (projectId) filter.projectId = projectId
      if (status) filter.status = status
      return textResponse(svc.findInbox(filter))
    }
  )

  server.registerTool(
    'inbox_get',
    {
      description: 'Get inbox item + linked conversation (if any)',
      inputSchema: { id: z.string().describe('Inbox item ID (e.g. INBOX-001)') }
    },
    async ({ id }) => {
      const item = svc.getInbox(id)
      if (!item) return textResponse(`Inbox ${id} not found`)
      const conversations = svc.findConversationsByLink('inbox', id).map((c) => ({
        id: c.id,
        title: c.title,
        status: c.status,
        decisionSummary: c.decisionSummary,
        messages: svc.getConversationMessages(c.id).map((m) => ({
          id: m.id,
          authorName: m.authorName,
          content: m.content,
          messageType: m.messageType,
          createdAt: m.createdAt
        }))
      }))
      return textResponse({ item, conversations })
    }
  )

  server.registerTool(
    'inbox_research',
    {
      description:
        'Start research on an inbox item. Transitions raw → researching, opens a conversation linked to the inbox, returns conversation ID. Research messages added via conversation_add.',
      inputSchema: {
        id: z.string().describe('Inbox item ID'),
        researcher: z.string().default('Claude').describe('Researcher name')
      }
    },
    async ({ id, researcher }) =>
      tryLifecycle(() => ({
        ...svc.startInboxResearch(id, researcher),
        hint: 'Add research findings via conversation_add. Call inbox_ready when done.'
      }))
  )

  server.registerTool(
    'inbox_ready',
    {
      description: 'Mark research complete. Transitions researching → ready.',
      inputSchema: { id: z.string().describe('Inbox item ID') }
    },
    async ({ id }) => {
      const item = svc.getInbox(id)
      if (!item) return textResponse(`Inbox ${id} not found`)
      if (item.status !== 'researching') {
        return textResponse(`Inbox ${id} is ${item.status}, not researching`)
      }
      return textResponse(svc.updateInbox(id, { status: 'ready' }))
    }
  )

  server.registerTool(
    'inbox_convert',
    {
      description:
        'Convert inbox item → task. Atomic: creates task, sets linked_task_id, transitions to converted, closes linked conversation.',
      inputSchema: {
        id: z.string().describe('Inbox item ID'),
        title: z.string().describe('Task title'),
        priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
        labels: z.array(z.string()).optional(),
        body: z.string().optional().describe('Task body (omit for default template)')
      }
    },
    async ({ id, title, priority, labels, body }) =>
      tryLifecycle(() => svc.convertInboxToTask(id, { title, priority, labels, body }))
  )

  server.registerTool(
    'inbox_archive',
    {
      description: 'Archive an inbox item (reject). Closes linked conversation.',
      inputSchema: {
        id: z.string().describe('Inbox item ID'),
        reason: z.string().optional().describe('Why archived')
      }
    },
    async ({ id, reason }) => tryLifecycle(() => svc.archiveInbox(id, reason))
  )

  server.registerTool(
    'inbox_delete',
    {
      description: 'Hard delete an inbox item. Only allowed for raw or archived items.',
      inputSchema: { id: z.string() }
    },
    async ({ id }) => {
      const item = svc.getInbox(id)
      if (!item) return textResponse(`Inbox ${id} not found`)
      if (item.status !== 'raw' && item.status !== 'archived') {
        return textResponse(
          `Inbox ${id} is ${item.status} — only raw or archived items can be deleted`
        )
      }
      svc.deleteInbox(id)
      return textResponse({ deleted: id })
    }
  )
}
