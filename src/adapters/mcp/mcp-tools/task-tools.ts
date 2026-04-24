import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { Phase } from '../../../core/domain/task-types'
import { textResponse } from './types'
import type { TaskOperations } from '../../../core/domain/interfaces/task-repository.interface'
import type { PhaseOperations } from '../../../core/domain/interfaces/phase-repository.interface'
import type { ConversationOperations } from '../../../core/domain/interfaces/conversation-repository.interface'
import type { TagOperations } from '../../../core/domain/interfaces/tag-repository.interface'
import type { RelationshipOperations } from '../../../core/domain/interfaces/relationship-repository.interface'
import type {
  ProjectOperations,
  WorkspaceOperations
} from '../../../core/domain/interfaces/project-repository.interface'
import { buildGraphifyContext } from './task-context-graphify'

export type TaskToolsDeps = TaskOperations &
  PhaseOperations &
  ConversationOperations &
  TagOperations &
  RelationshipOperations &
  ProjectOperations &
  WorkspaceOperations

export function defaultBody(id: string, title: string): string {
  return `# ${id}: ${title}

## Context

<!-- WHY: friction, constraint, background -->

## Acceptance

- [ ]

## Test Plan

<!-- HOW verify: tool, scenario, edge case -->

## Related

-
`
}

export const register = (server: McpServer, svc: TaskToolsDeps): void => {
  server.registerTool(
    'task_context',
    {
      description:
        'Get full context for a task: task details + phase + dependencies + body. Body follows template with ## Context / ## Acceptance / ## Test Plan / ## Related sections — read ## Acceptance for done criteria (tick each item before marking DONE); if empty, ask user to define before starting work.',
      inputSchema: { id: z.string().describe('Task ID (e.g. TASK-401)') }
    },
    async ({ id }) => {
      const task = svc.getTask(id)
      if (!task) return textResponse(`Task ${id} not found`)

      const deps = svc.getDependencies(id)
      const subtasks = svc.getSubtasks(id)
      const tags = svc.getTags(id)
      const rels = svc.getRelationships(id)

      let phase: Phase | null = null
      if (task.phaseId) {
        phase = svc.getPhase(task.phaseId)
      }

      const conversations = svc.findConversationsByLink('task', id).map((c) => ({
        id: c.id,
        title: c.title,
        status: c.status,
        decisionSummary: c.decisionSummary,
        actions: svc.getConversationActions(c.id).map((a) => ({
          assignee: a.assignee,
          description: a.description,
          status: a.status,
          linkedTaskId: a.linkedTaskId
        }))
      }))

      const graphify_context = buildGraphifyContext(task, svc)

      return textResponse({
        task,
        phase,
        dependencies: deps,
        subtasks,
        tags,
        relationships: rels,
        conversations,
        body: task.body,
        graphify_context
      })
    }
  )

  server.registerTool(
    'task_list',
    {
      description:
        'List tasks filtered by status (required). Returns compact shape by default (id, projectId, title, status, priority, labels); pass verbose=true for full task including body. For cross-status search use the search tool.',
      inputSchema: {
        projectId: z.string().optional().describe('Filter by project ID'),
        status: z
          .enum(['TODO', 'READY', 'IN-PROGRESS', 'DONE'])
          .describe('Required — filter by status to avoid dumping the full project list'),
        priority: z
          .enum(['critical', 'high', 'medium', 'low'])
          .optional()
          .describe('Filter by priority'),
        query: z.string().optional().describe('Search title'),
        labels: z
          .array(z.string())
          .optional()
          .describe('Filter by labels — OR semantics (match any). Empty/omitted = no label filter'),
        limit: z.number().optional().describe('Max results'),
        verbose: z
          .boolean()
          .optional()
          .describe('Return full task objects including body (default: false = compact)')
      }
    },
    async ({ verbose, ...filter }) => {
      const results = svc.findTasks(filter)
      if (verbose) return textResponse(results)
      return textResponse(
        results.map((t) => ({
          id: t.id,
          projectId: t.projectId,
          title: t.title,
          status: t.status,
          priority: t.priority,
          labels: t.labels
        }))
      )
    }
  )

  server.registerTool(
    'task_create',
    {
      description: 'Create a new task (body stored in SQLite)',
      inputSchema: {
        id: z.string().optional().describe('Task ID (auto-generated if omitted)'),
        projectId: z.string().describe('Project ID'),
        title: z.string().describe('Task title'),
        status: z.enum(['TODO', 'READY', 'IN-PROGRESS', 'DONE']).optional(),
        priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
        phaseId: z.string().optional().describe('Phase to assign to'),
        parentTaskId: z.string().optional().describe('Parent task for subtasks'),
        labels: z.array(z.string()).optional(),
        dueDate: z.string().optional(),
        body: z.string().optional().describe('Markdown body content (default template if omitted)')
      }
    },
    async (input) => {
      const task = svc.createTask(input)
      const body = input.body ?? defaultBody(task.id, task.title)
      const updated = svc.updateTask(task.id, { body })
      return textResponse(updated)
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
        phaseId: z.string().nullable().optional(),
        parentTaskId: z.string().nullable().optional(),
        labels: z.array(z.string()).optional(),
        dueDate: z.string().nullable().optional(),
        pinned: z.boolean().optional(),
        body: z.string().nullable().optional()
      }
    },
    async ({ id, ...input }) => textResponse(svc.updateTask(id, input))
  )

  server.registerTool(
    'tasks_update_batch',
    {
      description: 'Update multiple tasks with the same patch (e.g. bulk mark DONE)',
      inputSchema: {
        ids: z.array(z.string()).describe('List of task IDs to update'),
        status: z.enum(['TODO', 'READY', 'IN-PROGRESS', 'DONE']).optional(),
        priority: z.enum(['critical', 'high', 'medium', 'low']).nullable().optional(),
        labels: z.array(z.string()).optional(),
        pinned: z.boolean().optional()
      }
    },
    async ({ ids, ...patch }) => {
      const results = ids.map((id) => svc.updateTask(id, patch))
      return textResponse(results)
    }
  )
}
