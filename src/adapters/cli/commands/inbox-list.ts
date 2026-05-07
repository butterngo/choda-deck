import { parseArgs } from 'node:util'
import type { InboxFilter, InboxItem, InboxStatus } from '../../../core/domain/task-types'
import { INBOX_STATUSES } from '../../../core/domain/task-types'
import { createCliServices } from '../service-factory'
import { renderJson } from '../render/json'
import { renderTable } from '../render/plain'

export const inboxListHelp = `Usage: choda-deck inbox list [options]

Options:
  --project <id>     Filter by project ID (use "global" for null projectId)
  --status <s>       raw | researching | ready | converted | archived
  --json             Emit JSON instead of plain text
`

export async function runInboxList(argv: string[]): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    options: {
      project: { type: 'string' },
      status: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false }
    },
    allowPositionals: false,
    strict: true
  })

  const v = parsed.values
  if (v.help) {
    process.stdout.write(inboxListHelp)
    return 0
  }

  if (v.status && !INBOX_STATUSES.includes(v.status as InboxStatus)) {
    process.stderr.write(
      `error: invalid --status "${v.status}". Must be one of: ${INBOX_STATUSES.join(', ')}\n`
    )
    return 2
  }

  const filter: InboxFilter = {
    status: v.status as InboxStatus | undefined,
    projectId: v.project === 'global' ? null : v.project
  }

  const { svc } = await createCliServices()
  const results: InboxItem[] = svc.findInbox(filter)

  if (v.json) {
    process.stdout.write(renderJson(results) + '\n')
    return 0
  }

  process.stdout.write(
    renderTable(results, [
      { header: 'ID', get: (i) => i.id, width: 12 },
      { header: 'STATUS', get: (i) => i.status, width: 12 },
      { header: 'PROJECT', get: (i) => i.projectId ?? '(global)', width: 14 },
      { header: 'LINKED', get: (i) => i.linkedTaskId ?? '-', width: 10 },
      { header: 'PREVIEW', get: (i) => firstLine(i.content).slice(0, 80) }
    ])
  )
  return 0
}

function firstLine(content: string): string {
  const trimmed = content.trimStart()
  const newline = trimmed.indexOf('\n')
  return newline === -1 ? trimmed : trimmed.slice(0, newline)
}
