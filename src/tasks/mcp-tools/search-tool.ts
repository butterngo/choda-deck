import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { textResponse } from './types'
import type { TaskOperations } from '../../core/domain/interfaces/task-repository.interface'
import type { TagOperations } from '../../core/domain/interfaces/tag-repository.interface'
import type { InboxOperations } from '../../core/domain/interfaces/inbox-repository.interface'

export type SearchToolsDeps = TaskOperations & TagOperations & InboxOperations

export const register = (server: McpServer, svc: SearchToolsDeps): void => {
  server.registerTool(
    'search',
    {
      description:
        'Search across tasks, phases, documents, and active inbox items (raw/researching/ready).',
      inputSchema: { query: z.string().describe('Search query') }
    },
    async ({ query }) => {
      const tasks = svc.findTasks({ query })
      const items = svc.findByTag(query)
      const q = query.toLowerCase()
      const inbox = svc
        .findInbox({})
        .filter(
          (i) =>
            (i.status === 'raw' || i.status === 'researching' || i.status === 'ready') &&
            i.content.toLowerCase().includes(q)
        )
        .slice(0, 20)

      return textResponse({
        tasks: tasks.slice(0, 20),
        taggedItems: items.slice(0, 20),
        inbox
      })
    }
  )
}
