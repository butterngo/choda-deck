import { z } from 'zod'
import { textResponse, type Register } from './types'

export const register: Register = (server, svc) => {
  server.registerTool(
    'roadmap',
    {
      description: 'Get full roadmap tree: phases → tasks with progress at each phase',
      inputSchema: { projectId: z.string().describe('Project ID') }
    },
    async ({ projectId }) => {
      const phases = svc.findPhases(projectId)
      const tasks = svc.findTasks({ projectId })

      const tree = phases.map((ph) => ({
        ...ph,
        progress: svc.getPhaseProgress(ph.id),
        tasks: tasks.filter((t) => t.phaseId === ph.id)
      }))

      return textResponse({
        phases: tree,
        unassigned: {
          tasks: tasks.filter((t) => !t.phaseId)
        }
      })
    }
  )
}
