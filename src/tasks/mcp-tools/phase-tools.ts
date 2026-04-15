import { z } from 'zod'
import { textResponse, type Register } from './types'

export const register: Register = (server, svc) => {
  server.tool(
    'phase_list',
    'List phases for a project with progress',
    { projectId: z.string().describe('Project ID') },
    async ({ projectId }) => {
      const phases = svc.findPhases(projectId)
      const result = phases.map(ph => ({
        ...ph,
        progress: svc.getPhaseProgress(ph.id)
      }))
      return textResponse(result)
    }
  )

  server.tool(
    'phase_create',
    'Create a new phase',
    {
      id: z.string().optional(),
      projectId: z.string(),
      title: z.string(),
      position: z.number().optional(),
      startDate: z.string().optional()
    },
    async (input) => textResponse(svc.createPhase(input))
  )
}
