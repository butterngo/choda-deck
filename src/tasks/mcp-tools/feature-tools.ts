import { z } from 'zod'
import { textResponse, type Register } from './types'

export const register: Register = (server, svc) => {
  server.registerTool(
    'feature_list',
    {
      description: 'List features for a project or phase with progress',
      inputSchema: {
        projectId: z.string().optional(),
        phaseId: z.string().optional()
      }
    },
    async ({ projectId, phaseId }) => {
      const features = phaseId
        ? svc.findFeaturesByPhase(phaseId)
        : projectId
          ? svc.findFeatures(projectId)
          : []
      const result = features.map(f => ({
        ...f,
        progress: svc.getFeatureProgress(f.id)
      }))
      return textResponse(result)
    }
  )

  server.registerTool(
    'feature_create',
    {
      description: 'Create a new feature',
      inputSchema: {
        id: z.string().optional(),
        projectId: z.string(),
        phaseId: z.string().optional(),
        title: z.string(),
        priority: z.enum(['critical', 'high', 'medium', 'low']).optional()
      }
    },
    async (input) => textResponse(svc.createFeature(input))
  )
}
