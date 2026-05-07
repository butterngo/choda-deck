import { parseArgs } from 'node:util'
import type { Task, TaskFilter, TaskStatus, TaskPriority } from '../../../core/domain/task-types'
import { createCliServices } from '../service-factory'
import { renderJson } from '../render/json'
import { renderTable } from '../render/plain'

const VALID_STATUSES: TaskStatus[] = ['TODO', 'READY', 'IN-PROGRESS', 'DONE', 'CANCELLED']
const VALID_PRIORITIES: TaskPriority[] = ['critical', 'high', 'medium', 'low']

export const taskListHelp = `Usage: choda-deck task list --status <status> [options]

Required:
  --status <s>       TODO | READY | IN-PROGRESS | DONE | CANCELLED

Options:
  --project <id>     Filter by project ID
  --priority <p>     critical | high | medium | low
  --query <text>     Search title (substring match)
  --labels <a,b>     Comma-separated labels (OR semantics)
  --limit <n>        Max results
  --verbose          Include task body in output
  --json             Emit JSON instead of plain text
`

export async function runTaskList(argv: string[]): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    options: {
      status: { type: 'string' },
      project: { type: 'string' },
      priority: { type: 'string' },
      query: { type: 'string' },
      labels: { type: 'string' },
      limit: { type: 'string' },
      verbose: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false }
    },
    allowPositionals: false,
    strict: true
  })

  const v = parsed.values
  if (v.help) {
    process.stdout.write(taskListHelp)
    return 0
  }

  if (!v.status) {
    process.stderr.write('error: --status is required\n\n' + taskListHelp)
    return 2
  }
  if (!VALID_STATUSES.includes(v.status as TaskStatus)) {
    process.stderr.write(
      `error: invalid --status "${v.status}". Must be one of: ${VALID_STATUSES.join(', ')}\n`
    )
    return 2
  }
  if (v.priority && !VALID_PRIORITIES.includes(v.priority as TaskPriority)) {
    process.stderr.write(
      `error: invalid --priority "${v.priority}". Must be one of: ${VALID_PRIORITIES.join(', ')}\n`
    )
    return 2
  }

  const filter: TaskFilter = {
    status: v.status as TaskStatus,
    projectId: v.project,
    priority: v.priority as TaskPriority | undefined,
    query: v.query,
    labels: v.labels ? v.labels.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    limit: v.limit ? parseIntStrict(v.limit, '--limit') : undefined
  }

  const { svc } = await createCliServices()
  const results: Task[] = svc.findTasks(filter)

  if (v.json) {
    const payload = v.verbose
      ? results
      : results.map((t) => ({
          id: t.id,
          projectId: t.projectId,
          title: t.title,
          status: t.status,
          priority: t.priority,
          labels: t.labels
        }))
    process.stdout.write(renderJson(payload) + '\n')
    return 0
  }

  process.stdout.write(
    renderTable(results, [
      { header: 'ID', get: (t) => t.id, width: 10 },
      { header: 'STATUS', get: (t) => t.status, width: 12 },
      { header: 'PRI', get: (t) => t.priority ?? '-', width: 8 },
      { header: 'PROJECT', get: (t) => t.projectId, width: 14 },
      { header: 'TITLE', get: (t) => t.title }
    ])
  )
  return 0
}

function parseIntStrict(raw: string, label: string): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(`${label} must be a non-negative integer (got "${raw}")`)
  }
  return n
}
