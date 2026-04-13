#!/usr/bin/env node
/**
 * MCP Task Server — exposes SQLite task management as MCP tools.
 * Run: npx ts-node src/tasks/mcp-task-server.ts
 * Env: CHODA_DB_PATH (default: ./choda-deck.db)
 *      CHODA_CONTENT_ROOT (default: none — required for file reads)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { SqliteTaskService } from './sqlite-task-service'
import type { Epic, Feature, Phase } from './task-types'
import * as fs from 'fs'
import * as path from 'path'

const DB_PATH = process.env.CHODA_DB_PATH || './choda-deck.db'
const CONTENT_ROOT = process.env.CHODA_CONTENT_ROOT || ''

async function main(): Promise<void> {
  const taskService = new SqliteTaskService(DB_PATH)
  await taskService.initializeAsync()

  const server = new McpServer(
    { name: 'choda-tasks', version: '0.1.0' },
    { capabilities: { tools: {} } }
  )

  // ── task_context ────────────────────────────────────────────────────────

  server.tool(
    'task_context',
    'Get full context for a task: task details + epic + feature + phase + dependencies + file content',
    { id: z.string().describe('Task ID (e.g. TASK-401)') },
    async ({ id }) => {
      const task = taskService.getTask(id)
      if (!task) return { content: [{ type: 'text' as const, text: `Task ${id} not found` }] }

      const deps = taskService.getDependencies(id)
      const subtasks = taskService.getSubtasks(id)
      const tags = taskService.getTags(id)
      const rels = taskService.getRelationships(id)

      let epic: Epic | null = null
      let feature: Feature | null = null
      let phase: Phase | null = null
      if (task.epicId) {
        epic = taskService.getEpic(task.epicId)
        if (epic?.featureId) {
          feature = taskService.getFeature(epic.featureId)
          if (feature?.phaseId) {
            phase = taskService.getPhase(feature.phaseId)
          }
        }
      }

      let fileContent: string | null = null
      if (task.filePath && fs.existsSync(task.filePath)) {
        try { fileContent = fs.readFileSync(task.filePath, 'utf-8') } catch { /* ignore */ }
      }

      const context = {
        task, epic, feature, phase,
        dependencies: deps, subtasks, tags, relationships: rels,
        fileContent
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify(context, null, 2) }] }
    }
  )

  // ── task_list ───────────────────────────────────────────────────────────

  server.tool(
    'task_list',
    'List tasks with optional filters',
    {
      projectId: z.string().optional().describe('Filter by project ID'),
      status: z.enum(['TODO', 'READY', 'IN-PROGRESS', 'DONE']).optional().describe('Filter by status'),
      priority: z.enum(['critical', 'high', 'medium', 'low']).optional().describe('Filter by priority'),
      epicId: z.string().optional().describe('Filter by epic ID'),
      query: z.string().optional().describe('Search title'),
      limit: z.number().optional().describe('Max results')
    },
    async (filter) => {
      const tasks = taskService.findTasks(filter)
      return { content: [{ type: 'text' as const, text: JSON.stringify(tasks, null, 2) }] }
    }
  )

  // ── task_create ─────────────────────────────────────────────────────────

  server.tool(
    'task_create',
    'Create a new task',
    {
      id: z.string().optional().describe('Task ID (auto-generated if omitted)'),
      projectId: z.string().describe('Project ID'),
      title: z.string().describe('Task title'),
      status: z.enum(['TODO', 'READY', 'IN-PROGRESS', 'DONE']).optional(),
      priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
      epicId: z.string().optional().describe('Epic to assign to'),
      parentTaskId: z.string().optional().describe('Parent task for subtasks'),
      labels: z.array(z.string()).optional(),
      dueDate: z.string().optional()
    },
    async (input) => {
      const task = taskService.createTask(input)

      // Write .md file if contentRoot is configured
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
          task.epicId ? `epic: ${task.epicId}` : '',
          task.dueDate ? `due-date: ${task.dueDate}` : '',
          '---',
          '',
          `# ${task.id}: ${task.title}`,
          ''
        ].filter(l => l !== '').join('\n')
        fs.writeFileSync(filePath, lines, 'utf-8')
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify(task, null, 2) }] }
    }
  )

  // ── task_update ─────────────────────────────────────────────────────────

  server.tool(
    'task_update',
    'Update a task',
    {
      id: z.string().describe('Task ID'),
      title: z.string().optional(),
      status: z.enum(['TODO', 'READY', 'IN-PROGRESS', 'DONE']).optional(),
      priority: z.enum(['critical', 'high', 'medium', 'low']).nullable().optional(),
      epicId: z.string().nullable().optional(),
      parentTaskId: z.string().nullable().optional(),
      labels: z.array(z.string()).optional(),
      dueDate: z.string().nullable().optional(),
      pinned: z.boolean().optional()
    },
    async ({ id, ...input }) => {
      const task = taskService.updateTask(id, input)
      return { content: [{ type: 'text' as const, text: JSON.stringify(task, null, 2) }] }
    }
  )

  // ── phase_list ──────────────────────────────────────────────────────────

  server.tool(
    'phase_list',
    'List phases for a project with progress',
    { projectId: z.string().describe('Project ID') },
    async ({ projectId }) => {
      const phases = taskService.findPhases(projectId)
      const result = phases.map(ph => ({
        ...ph,
        progress: taskService.getPhaseProgress(ph.id)
      }))
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
    }
  )

  // ── phase_create ────────────────────────────────────────────────────────

  server.tool(
    'phase_create',
    'Create a new phase',
    {
      id: z.string().optional(),
      projectId: z.string(),
      title: z.string(),
      position: z.number().optional(),
      targetDate: z.string().optional()
    },
    async (input) => {
      const phase = taskService.createPhase(input)
      return { content: [{ type: 'text' as const, text: JSON.stringify(phase, null, 2) }] }
    }
  )

  // ── feature_list ────────────────────────────────────────────────────────

  server.tool(
    'feature_list',
    'List features for a project or phase with progress',
    {
      projectId: z.string().optional(),
      phaseId: z.string().optional()
    },
    async ({ projectId, phaseId }) => {
      const features = phaseId
        ? taskService.findFeaturesByPhase(phaseId)
        : projectId
          ? taskService.findFeatures(projectId)
          : []
      const result = features.map(f => ({
        ...f,
        progress: taskService.getFeatureProgress(f.id)
      }))
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
    }
  )

  // ── feature_create ──────────────────────────────────────────────────────

  server.tool(
    'feature_create',
    'Create a new feature',
    {
      id: z.string().optional(),
      projectId: z.string(),
      phaseId: z.string().optional(),
      title: z.string(),
      priority: z.enum(['critical', 'high', 'medium', 'low']).optional()
    },
    async (input) => {
      const feature = taskService.createFeature(input)
      return { content: [{ type: 'text' as const, text: JSON.stringify(feature, null, 2) }] }
    }
  )

  // ── roadmap ─────────────────────────────────────────────────────────────

  server.tool(
    'roadmap',
    'Get full roadmap tree: phases → features → epics → tasks with progress at each level',
    { projectId: z.string().describe('Project ID') },
    async ({ projectId }) => {
      const phases = taskService.findPhases(projectId)
      const features = taskService.findFeatures(projectId)
      const epics = taskService.findEpics(projectId)
      const tasks = taskService.findTasks({ projectId })

      const tree = phases.map(ph => ({
        ...ph,
        progress: taskService.getPhaseProgress(ph.id),
        features: features.filter(f => f.phaseId === ph.id).map(f => ({
          ...f,
          progress: taskService.getFeatureProgress(f.id),
          epics: epics.filter(e => e.featureId === f.id).map(e => ({
            ...e,
            progress: taskService.getEpicProgress(e.id),
            tasks: tasks.filter(t => t.epicId === e.id)
          }))
        }))
      }))

      // Unassigned items
      const unassignedFeatures = features.filter(f => !f.phaseId)
      const unassignedEpics = epics.filter(e => !e.featureId)
      const unassignedTasks = tasks.filter(t => !t.epicId)

      const result = {
        phases: tree,
        unassigned: {
          features: unassignedFeatures,
          epics: unassignedEpics,
          tasks: unassignedTasks
        }
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
    }
  )

  // ── search ──────────────────────────────────────────────────────────────

  server.tool(
    'search',
    'Search across tasks, phases, features, and documents',
    { query: z.string().describe('Search query') },
    async ({ query }) => {
      const tasks = taskService.findTasks({ query })
      const items = taskService.findByTag(query)

      const result = {
        tasks: tasks.slice(0, 20),
        taggedItems: items.slice(0, 20)
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
    }
  )

  // ── Start server ────────────────────────────────────────────────────────

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  console.error('MCP Task Server failed:', err)
  process.exit(1)
})
