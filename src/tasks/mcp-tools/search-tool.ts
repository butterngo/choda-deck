import { z } from 'zod'
import { textResponse, type Register } from './types'

export const register: Register = (server, svc) => {
  server.registerTool(
    'search',
    {
      description: 'Search across tasks, phases, features, and documents',
      inputSchema: { query: z.string().describe('Search query') }
    },
    async ({ query }) => {
      const tasks = svc.findTasks({ query })
      const items = svc.findByTag(query)

      return textResponse({
        tasks: tasks.slice(0, 20),
        taggedItems: items.slice(0, 20)
      })
    }
  )
}
