import { parseArgs } from 'node:util'
import type { KnowledgeEntry } from '../../../core/domain/knowledge-types'
import { createCliServices } from '../service-factory'
import { renderJson } from '../render/json'

export const knowledgeShowHelp = `Usage: choda-deck knowledge show <slug> [options]

Options:
  --json       Emit JSON instead of plain text
`

export async function runKnowledgeShow(argv: string[]): Promise<number> {
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
    process.stdout.write(knowledgeShowHelp)
    return 0
  }

  const slug = parsed.positionals[0]
  if (!slug) {
    process.stderr.write(`error: knowledge slug is required\n\n${knowledgeShowHelp}`)
    return 2
  }

  const { svc } = await createCliServices()
  const entry = svc.getKnowledge(slug)
  if (!entry) {
    process.stderr.write(`error: knowledge entry "${slug}" not found\n`)
    return 1
  }

  if (parsed.values.json) {
    process.stdout.write(renderJson(entry) + '\n')
    return 0
  }

  process.stdout.write(formatKnowledgePlain(entry))
  return 0
}

function formatKnowledgePlain(entry: KnowledgeEntry): string {
  const fm = entry.frontmatter
  const lines: string[] = []
  lines.push(`# ${entry.slug}: ${fm.title}`)
  lines.push('')
  lines.push(`Type:        ${fm.type}`)
  lines.push(`Scope:       ${fm.scope}`)
  lines.push(`Project:     ${fm.projectId}`)
  if (fm.workspaceId) lines.push(`Workspace:   ${fm.workspaceId}`)
  lines.push(`Verified:    ${fm.lastVerifiedAt}`)
  lines.push(`File:        ${entry.filePath}`)
  lines.push(`Stale:       ${entry.isStale ? 'YES' : 'no'}`)
  if (entry.staleness.length > 0) {
    lines.push('')
    lines.push('## Refs')
    for (const r of entry.staleness) {
      const flag = r.commitsSince > 0 ? `STALE +${r.commitsSince}` : 'fresh'
      lines.push(`  - [${flag}] ${r.path} (${r.commitSha.slice(0, 8)})`)
    }
  }
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push(entry.body)
  lines.push('')
  return lines.join('\n')
}
