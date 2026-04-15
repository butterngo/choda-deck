import { z } from 'zod'
import { textResponse, type Register } from './types'

export const register: Register = (server, svc) => {
  server.registerTool(
    'phase_list',
    {
      description: 'List phases for a project with progress',
      inputSchema: { projectId: z.string().describe('Project ID') }
    },
    async ({ projectId }) => {
      const phases = svc.findPhases(projectId)
      const result = phases.map(ph => ({
        ...ph,
        progress: svc.getPhaseProgress(ph.id)
      }))
      return textResponse(result)
    }
  )

  server.registerTool(
    'phase_create',
    {
      description: 'Create a new phase',
      inputSchema: {
        id: z.string().optional(),
        projectId: z.string(),
        title: z.string(),
        position: z.number().optional(),
        startDate: z.string().optional()
      }
    },
    async (input) => textResponse(svc.createPhase(input))
  )
}
