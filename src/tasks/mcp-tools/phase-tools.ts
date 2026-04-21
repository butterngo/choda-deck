import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { textResponse } from './types'
import type { PhaseOperations } from '../../core/domain/interfaces/phase-repository.interface'

export type PhaseToolsDeps = PhaseOperations

export const register = (server: McpServer, svc: PhaseToolsDeps): void => {
  server.registerTool(
    'phase_list',
    {
      description: 'List phases for a project with progress',
      inputSchema: { projectId: z.string().describe('Project ID') }
    },
    async ({ projectId }) => {
      const phases = svc.findPhases(projectId)
      const result = phases.map((ph) => ({
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
