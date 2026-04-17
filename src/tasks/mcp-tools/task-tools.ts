import { z } from 'zod'
import * as fs from 'fs'
import * as path from 'path'
import type { Feature, Phase, Task } from '../task-types'
import { textResponse, type Register } from './types'

const CONTENT_ROOT = process.env.CHODA_CONTENT_ROOT || ''

function renderTaskFile(task: Task): string {
  const frontmatter = [
    '---',
    `id: ${task.id}`,
    `title: ${task.title}`,
    `status: ${(task.status || 'todo').toLowerCase()}`,
    task.priority ? `priority: ${task.priority}` : '',
    task.featureId ? `feature: ${task.featureId}` : '',
    task.dueDate ? `due-date: ${task.dueDate}` : '',
    '---'
  ].filter(l => l !== '').join('\n')

  const body = `# ${task.id}: ${task.title}

## Why

<!-- What friction, constraint, or motivation drives this task? -->

## Acceptance criteria

- [ ]

## Scope

-

## Out of scope

-

## Notes
`

  return `${frontmatter}\n\n${body}`
}

export const register: Register = (server, svc) => {
  server.registerTool(
    'task_context',
    {
      description: 'Get full context for a task: task details + feature + phase + dependencies + file content',
      inputSchema: { id: z.string().describe('Task ID (e.g. TASK-401)') }
    },
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

      const conversations = svc.findConversationsByLink('task', id).map(c => ({
        id: c.id,
        title: c.title,
        status: c.status,
        decisionSummary: c.decisionSummary,
        actions: svc.getConversationActions(c.id).map(a => ({
          assignee: a.assignee,
          description: a.description,
          status: a.status,
          linkedTaskId: a.linkedTaskId
        }))
      }))

      return textResponse({
        task, feature, phase,
        dependencies: deps, subtasks, tags, relationships: rels,
        conversations,
        fileContent
      })
    }
  )

  server.registerTool(
    'task_list',
    {
      description: 'List tasks with optional filters',
      inputSchema: {
        projectId: z.string().optional().describe('Filter by project ID'),
        status: z.enum(['TODO', 'READY', 'IN-PROGRESS', 'DONE']).optional().describe('Filter by status'),
        priority: z.enum(['critical', 'high', 'medium', 'low']).optional().describe('Filter by priority'),
        featureId: z.string().optional().describe('Filter by feature ID'),
        query: z.string().optional().describe('Search title'),
        limit: z.number().optional().describe('Max results')
      }
    },
    async (filter) => textResponse(svc.findTasks(filter))
  )

  server.registerTool(
    'task_create',
    {
      description: 'Create a new task',
      inputSchema: {
        id: z.string().optional().describe('Task ID (auto-generated if omitted)'),
        projectId: z.string().describe('Project ID'),
        title: z.string().describe('Task title'),
        status: z.enum(['TODO', 'READY', 'IN-PROGRESS', 'DONE']).optional(),
        priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
        featureId: z.string().optional().describe('Feature to assign to'),
        parentTaskId: z.string().optional().describe('Parent task for subtasks'),
        labels: z.array(z.string()).optional(),
        dueDate: z.string().optional()
      }
    },
    async (input) => {
      const task = svc.createTask(input)

      if (CONTENT_ROOT && task.id) {
        const dir = path.join(CONTENT_ROOT, '10-Projects', input.projectId, 'tasks')
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
        const filePath = path.join(dir, `${task.id}.md`)
        fs.writeFileSync(filePath, renderTaskFile(task), 'utf-8')
        svc.updateTask(task.id, { filePath })
      }

      return textResponse(task)
    }
  )

  server.registerTool(
    'task_update',
    {
      description: 'Update a task',
      inputSchema: {
        id: z.string().describe('Task ID'),
        title: z.string().optional(),
        status: z.enum(['TODO', 'READY', 'IN-PROGRESS', 'DONE']).optional(),
        priority: z.enum(['critical', 'high', 'medium', 'low']).nullable().optional(),
        featureId: z.string().nullable().optional(),
        parentTaskId: z.string().nullable().optional(),
        labels: z.array(z.string()).optional(),
        dueDate: z.string().nullable().optional(),
        pinned: z.boolean().optional()
      }
    },
    async ({ id, ...input }) => textResponse(svc.updateTask(id, input))
  )
}
