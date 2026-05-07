import { parseArgs } from 'node:util'
import type { Task, TaskDependency, Relationship } from '../../../core/domain/task-types'
import { createCliServices } from '../service-factory'
import { renderJson } from '../render/json'

export const taskShowHelp = `Usage: choda-deck task show <id> [options]

Options:
  --json       Emit JSON instead of plain text
`

export interface TaskShowResult {
  task: Task
  dependencies: TaskDependency[]
  subtasks: Task[]
  tags: string[]
  relationships: Relationship[]
  conversations: Array<{
    id: string
    title: string
    status: string
    decisionSummary: string | null
    actions: Array<{
      assignee: string
      description: string
      status: string
      linkedTaskId: string | null
    }>
  }>
}

export async function runTaskShow(argv: string[]): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    options: {
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false }
    },
    allowPositionals: true,
    strict: true
  })

  if (parsed.values.help) {
    process.stdout.write(taskShowHelp)
    return 0
  }

  const id = parsed.positionals[0]
  if (!id) {
    process.stderr.write(`error: task id is required\n\n${taskShowHelp}`)
    return 2
  }

  const { svc } = await createCliServices()
  const task = svc.getTask(id)
  if (!task) {
    process.stderr.write(`error: task ${id} not found\n`)
    return 1
  }

  const result: TaskShowResult = {
    task,
    dependencies: svc.getDependencies(id),
    subtasks: svc.getSubtasks(id),
    tags: svc.getTags(id),
    relationships: svc.getRelationships(id),
    conversations: svc.findConversationsByLink('task', id).map((c) => ({
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
  }

  if (parsed.values.json) {
    process.stdout.write(renderJson(result) + '\n')
    return 0
  }

  process.stdout.write(formatTaskPlain(result))
  return 0
}

function formatTaskPlain(r: TaskShowResult): string {
  const t = r.task
  const lines: string[] = []
  lines.push(`# ${t.id}: ${t.title}`)
  lines.push('')
  lines.push(`Status:   ${t.status}`)
  lines.push(`Priority: ${t.priority ?? '-'}`)
  lines.push(`Project:  ${t.projectId}`)
  if (t.labels.length > 0) lines.push(`Labels:   ${t.labels.join(', ')}`)
  if (t.parentTaskId) lines.push(`Parent:   ${t.parentTaskId}`)
  if (t.blockedBy.length > 0) lines.push(`Blocked:  ${t.blockedBy.join(', ')}`)
  if (t.dueDate) lines.push(`Due:      ${t.dueDate}`)
  if (t.pinned) lines.push('Pinned:   yes')
  lines.push(`Created:  ${t.createdAt}`)
  lines.push(`Updated:  ${t.updatedAt}`)
  lines.push('')

  if (r.dependencies.length > 0) {
    lines.push('## Dependencies')
    for (const d of r.dependencies) lines.push(`  - ${d.targetId}`)
    lines.push('')
  }

  if (r.subtasks.length > 0) {
    lines.push('## Subtasks')
    for (const s of r.subtasks) lines.push(`  - ${s.id} [${s.status}] ${s.title}`)
    lines.push('')
  }

  if (r.conversations.length > 0) {
    lines.push('## Conversations')
    for (const c of r.conversations) {
      lines.push(`  - ${c.id} [${c.status}] ${c.title}`)
      if (c.decisionSummary) {
        const summary = c.decisionSummary.split('\n')[0].slice(0, 120)
        lines.push(`    decision: ${summary}`)
      }
    }
    lines.push('')
  }

  if (t.body) {
    lines.push('---')
    lines.push('')
    lines.push(t.body)
    lines.push('')
  }

  return lines.join('\n')
}
