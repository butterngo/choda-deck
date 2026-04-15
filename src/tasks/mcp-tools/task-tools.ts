import { z } from 'zod'
import * as fs from 'fs'
import * as path from 'path'
import type { Feature, Phase } from '../task-types'
import { textResponse, type Register } from './types'

const CONTENT_ROOT = process.env.CHODA_CONTENT_ROOT || ''

export const register: Register = (server, svc) => {
  server.tool(
    'task_context',
    'Get full context for a task: task details + feature + phase + dependencies + file content',
    { id: z.string().describe('Task ID (e.g. TASK-401)') },
    async ({ id }) => {
      const task = svc.getTask(id)
      if (!task) return textResponse(`Task ${id} not found`)

      const deps = svc.getDependencies(id)
      const subtasks = svc.getSubtasks(id)
      const tags = svc.getTags(id)
      const rels = svc.getRelationships(id)

      let feature: Feature | null = null
      let phase: Phase | null = null
      if (task.featureId) {
        feature = svc.getFeature(task.featureId)
        if (feature?.phaseId) {
          phase = svc.getPhase(feature.phaseId)
        }
      }

      let fileContent: string | null = null
      if (task.filePath && fs.existsSync(task.filePath)) {
        try { fileContent = fs.readFileSync(task.filePath, 'utf-8') } catch { /* ignore */ }
      }

      return textResponse({
        task, feature, phase,
        dependencies: deps, subtasks, tags, relationships: rels,
        fileContent
      })
    }
  )

  server.tool(
    'task_list',
    'List tasks with optional filters',
    {
      projectId: z.string().optional().describe('Filter by project ID'),
      status: z.enum(['TODO', 'READY', 'IN-PROGRESS', 'DONE']).optional().describe('Filter by status'),
      priority: z.enum(['critical', 'high', 'medium', 'low']).optional().describe('Filter by priority'),
      featureId: z.string().optional().describe('Filter by feature ID'),
      query: z.string().optional().describe('Search title'),
      limit: z.number().optional().describe('Max results')
    },
    async (filter) => textResponse(svc.findTasks(filter))
  )

  server.tool(
    'task_create',
    'Create a new task',
    {
      id: z.string().optional().describe('Task ID (auto-generated if omitted)'),
      projectId: z.string().describe('Project ID'),
      title: z.string().describe('Task title'),
      status: z.enum(['TODO', 'READY', 'IN-PROGRESS', 'DONE']).optional(),
      priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
      featureId: z.string().optional().describe('Feature to assign to'),
      parentTaskId: z.string().optional().describe('Parent task for subtasks'),
      labels: z.array(z.string()).optional(),
      dueDate: z.string().optional()
    },
    async (input) => {
      const task = svc.createTask(input)

      if (CONTENT_ROOT && task.id) {
        const dir = path.join(CONTENT_ROOT, '10-Projects', input.projectId, 'tasks')
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
        const slug = task.title.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
        const filePath = path.join(dir, `${task.id}_${slug}.md`)
        const lines = [
          '---',
          `id: ${task.id}`,
          `title: ${task.title}`,
          `status: ${(task.status || 'todo').toLowerCase()}`,
          task.priority ? `priority: ${task.priority}` : '',
          task.featureId ? `feature: ${task.featureId}` : '',
          task.dueDate ? `due-date: ${task.dueDate}` : '',
          '---',
          '',
          `# ${task.id}: ${task.title}`,
          ''
        ].filter(l => l !== '').join('\n')
        fs.writeFileSync(filePath, lines, 'utf-8')
      }

      return textResponse(task)
    }
  )

  server.tool(
    'task_update',
    'Update a task',
    {
      id: z.string().describe('Task ID'),
      title: z.string().optional(),
      status: z.enum(['TODO', 'READY', 'IN-PROGRESS', 'DONE']).optional(),
      priority: z.enum(['critical', 'high', 'medium', 'low']).nullable().optional(),
      featureId: z.string().nullable().optional(),
      parentTaskId: z.string().nullable().optional(),
      labels: z.array(z.string()).optional(),
      dueDate: z.string().nullable().optional(),
      pinned: z.boolean().optional()
    },
    async ({ id, ...input }) => textResponse(svc.updateTask(id, input))
  )
}
