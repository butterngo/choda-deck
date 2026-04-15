import { z } from 'zod'
import { textResponse, type Register } from './types'
import { buildProjectContext } from './project-context-builder'

export const register: Register = (server, svc) => {
  server.registerTool(
    'project_context',
    {
      description: 'Compile full project context: identity, current state (active phase + tasks + last session + open conversations), architecture, conventions, recent decisions, and the list of context sources used',
      inputSchema: {
        projectId: z.string().describe('Project ID'),
        depth: z.enum(['summary', 'full']).optional().describe('full (default) or summary (truncated)')
      }
    },
    async ({ projectId, depth }) => {
      const bundle = buildProjectContext(svc, projectId, depth ?? 'full')
      if (!bundle) return textResponse(`Project ${projectId} not found`)
      return textResponse(bundle)
    }
  )
}
