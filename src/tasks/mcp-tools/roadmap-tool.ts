import { z } from 'zod'
import { textResponse, type Register } from './types'

export const register: Register = (server, svc) => {
  server.tool(
    'roadmap',
    'Get full roadmap tree: phases → features → tasks with progress at each level',
    { projectId: z.string().describe('Project ID') },
    async ({ projectId }) => {
      const phases = svc.findPhases(projectId)
      const features = svc.findFeatures(projectId)
      const tasks = svc.findTasks({ projectId })

      const tree = phases.map(ph => ({
        ...ph,
        progress: svc.getPhaseProgress(ph.id),
        features: features.filter(f => f.phaseId === ph.id).map(f => ({
          ...f,
          progress: svc.getFeatureProgress(f.id),
          tasks: tasks.filter(t => t.featureId === f.id)
        }))
      }))

      return textResponse({
        phases: tree,
        unassigned: {
          features: features.filter(f => !f.phaseId),
          tasks: tasks.filter(t => !t.featureId)
        }
      })
    }
  )
}
