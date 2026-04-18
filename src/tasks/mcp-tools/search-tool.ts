import { z } from 'zod'
import { textResponse, type Register } from './types'

export const register: Register = (server, svc) => {
  server.registerTool(
    'search',
    {
      description:
        'Search across tasks, phases, features, documents, and active inbox items (raw/researching/ready).',
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
