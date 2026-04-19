import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { textResponse } from './types'
import type { TaskOperations } from '../interfaces/task-repository.interface'
import type { PhaseOperations } from '../interfaces/phase-repository.interface'

export type RoadmapToolsDeps = TaskOperations & PhaseOperations

export const register = (server: McpServer, svc: RoadmapToolsDeps): void => {
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
