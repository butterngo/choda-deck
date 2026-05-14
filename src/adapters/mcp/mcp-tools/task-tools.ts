import type { InstrumentedServer } from '../instrumented-server'
import { z } from 'zod'
import { textResponse } from './types'
import type { TaskOperations } from '../../../core/domain/interfaces/task-repository.interface'
import type { ConversationOperations } from '../../../core/domain/interfaces/conversation-repository.interface'
import type { TagOperations } from '../../../core/domain/interfaces/tag-repository.interface'
import type { RelationshipOperations } from '../../../core/domain/interfaces/relationship-repository.interface'
import type { ProjectOperations } from '../../../core/domain/interfaces/project-repository.interface'
import type { WorkspaceOperations } from '../../../core/domain/interfaces/workspace-repository.interface'
import { buildGraphifyContext } from './task-context-graphify'
import {
  AUTO_SAFE_LABEL,
  validateAutoSafeTask
} from '../../../core/domain/auto-safe-validator'
import type { Task, UpdateTaskInput } from '../../../core/domain/task-types'

export type TaskToolsDeps = TaskOperations &
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

export const register = (server: InstrumentedServer, svc: TaskToolsDeps): void => {
  server.registerTool(
    'task_context',
    {
      description:
        'Get full context for a task: task details + dependencies + body. Body follows template with ## Context / ## Acceptance / ## Test Plan / ## Related sections — read ## Acceptance for done criteria (tick each item before marking DONE); if empty, ask user to define before starting work.',
      inputSchema: { id: z.string().describe('Task ID (e.g. TASK-401)') }
    },
    async ({ id }) => {
      const task = svc.getTask(id)
      if (!task) return textResponse(`Task ${id} not found`)

      const deps = svc.getDependencies(id)
      const subtasks = svc.getSubtasks(id)
      const tags = svc.getTags(id)
      const rels = svc.getRelationships(id)

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
        'List tasks filtered by status (required). Returns compact shape by default (id, projectId, title, status, priority, labels); pass verbose=true for full task including body.',
      inputSchema: {
        projectId: z.string().optional().describe('Filter by project ID'),
        status: z
          .enum(['TODO', 'READY', 'IN-PROGRESS', 'DONE', 'CANCELLED'])
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
        status: z.enum(['TODO', 'READY', 'IN-PROGRESS', 'DONE', 'CANCELLED']).optional(),
        priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
        parentTaskId: z.string().optional().describe('Parent task for subtasks'),
        labels: z.array(z.string()).optional(),
        dueDate: z.string().optional(),
        body: z.string().optional().describe('Markdown body content (default template if omitted)'),
        blockedBy: z
          .array(z.string())
          .optional()
          .describe(
            'Task IDs blocking this task — must all be DONE/CANCELLED before this can be DONE; also excluded from READY list'
          )
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
      description:
        'Update a task. Status=DONE is hard-blocked if any subtask or blockedBy task is not DONE/CANCELLED — error lists blockers. ' +
        '`body` and `title` are locked when status ∈ {IN-PROGRESS, DONE, CANCELLED} to prevent silent spec drift — reset to TODO/READY first.',
      inputSchema: {
        id: z.string().describe('Task ID'),
        title: z.string().optional(),
        status: z.enum(['TODO', 'READY', 'IN-PROGRESS', 'DONE', 'CANCELLED']).optional(),
        priority: z.enum(['critical', 'high', 'medium', 'low']).nullable().optional(),
        parentTaskId: z.string().nullable().optional(),
        labels: z.array(z.string()).optional(),
        dueDate: z.string().nullable().optional(),
        pinned: z.boolean().optional(),
        body: z.string().nullable().optional(),
        blockedBy: z
          .array(z.string())
          .optional()
          .describe('Replace blockedBy list (pass empty array to clear)')
      }
    },
    async ({ id, ...input }) => {
      enforceBodyTitleLock(svc, id, input)
      enforceAutoSafe(svc, id, input)
      return textResponse(svc.updateTask(id, input))
    }
  )
}

const LOCKED_STATUSES = ['IN-PROGRESS', 'DONE', 'CANCELLED'] as const

function enforceBodyTitleLock(svc: TaskToolsDeps, id: string, input: UpdateTaskInput): void {
  const touchingBody = 'body' in input
  const touchingTitle = 'title' in input
  if (!touchingBody && !touchingTitle) return
  const current = svc.getTask(id)
  if (!current) return
  if (!LOCKED_STATUSES.includes(current.status as (typeof LOCKED_STATUSES)[number])) return
  const field = touchingBody && touchingTitle ? 'body/title' : touchingBody ? 'body' : 'title'
  throw new Error(
    `task_update: cannot update ${field} when status=${current.status}.\n` +
      `Reason: worker may be executing with current AC; silent spec drift causes ` +
      `drift between code and intent.\n` +
      `To update: reset status to TODO or READY first, update ${field}, then resume.`
  )
}

function enforceAutoSafe(svc: TaskToolsDeps, id: string, input: UpdateTaskInput): void {
  if (!input.labels?.includes(AUTO_SAFE_LABEL)) return
  const current = svc.getTask(id)
  if (!current) return
  if (current.labels.includes(AUTO_SAFE_LABEL)) return
  const probe: Task = {
    ...current,
    body: input.body !== undefined ? input.body : current.body
  }
  const result = validateAutoSafeTask(probe)
  if (!result.valid) {
    throw new Error(
      `Cannot add 'auto-safe' label to ${id} — task body fails contract:\n` +
        result.errors.map((e) => `  - ${e}`).join('\n')
    )
  }
}
