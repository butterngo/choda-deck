import { parseArgs } from 'node:util'
import {
  buildProjectContext,
  type ProjectContextBundle,
  type ProjectContextDepth
} from '../../mcp/mcp-tools/project-context-builder'
import { createCliServices } from '../service-factory'
import { renderJson } from '../render/json'

export const projectContextHelp = `Usage: choda-deck project context <projectId> [options]

Options:
  --depth <d>  full | summary  (default: full)
  --json       Emit JSON instead of plain text
`

export async function runProjectContext(argv: string[]): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    options: {
      depth: { type: 'string', default: 'full' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false }
    },
    allowPositionals: true,
    strict: true
  })

  if (parsed.values.help) {
    process.stdout.write(projectContextHelp)
    return 0
  }

  const projectId = parsed.positionals[0]
  if (!projectId) {
    process.stderr.write(`error: projectId is required\n\n${projectContextHelp}`)
    return 2
  }

  const depth = parsed.values.depth as string
  if (depth !== 'full' && depth !== 'summary') {
    process.stderr.write(`error: invalid --depth "${depth}". Must be one of: full, summary\n`)
    return 2
  }

  const { svc } = await createCliServices()
  const bundle = buildProjectContext(svc, projectId, depth as ProjectContextDepth)
  if (!bundle) {
    process.stderr.write(`error: project "${projectId}" not found\n`)
    return 1
  }

  if (parsed.values.json) {
    process.stdout.write(renderJson(bundle) + '\n')
    return 0
  }

  process.stdout.write(formatPlain(bundle))
  return 0
}

function formatPlain(b: ProjectContextBundle): string {
  const lines: string[] = []
  lines.push(`# ${b.project.name} (${b.project.id})`)
  lines.push(`cwd: ${b.project.cwd}`)
  lines.push('')

  lines.push('## Active tasks')
  if (b.currentState.activeTasks.length === 0) {
    lines.push('  (none)')
  } else {
    for (const t of b.currentState.activeTasks) {
      lines.push(`  - ${t.id} [${t.status}, ${t.priority ?? '-'}] ${t.title}`)
    }
  }
  lines.push('')

  lines.push('## Last session')
  if (!b.currentState.lastSession) {
    lines.push('  (none)')
  } else {
    const s = b.currentState.lastSession
    lines.push(`  ${s.id} ended ${s.endedAt ?? '-'}`)
    if (s.handoff?.resumePoint) lines.push(`  resume: ${s.handoff.resumePoint}`)
  }
  lines.push('')

  lines.push('## Open conversations')
  if (b.currentState.openConversations.length === 0) {
    lines.push('  (none)')
  } else {
    for (const c of b.currentState.openConversations) {
      lines.push(`  - ${c.id} [${c.status}] ${c.title.slice(0, 80)}`)
    }
  }
  lines.push('')

  if (b.recentDecisions.length > 0) {
    lines.push('## Recent decisions')
    for (const d of b.recentDecisions) {
      lines.push(`  - ${d.label} (${d.sourcePath})`)
    }
    lines.push('')
  }

  if (b.architecture) {
    lines.push('## Architecture')
    lines.push('')
    lines.push(b.architecture.trim())
    lines.push('')
  }

  if (b.conventions) {
    lines.push('## Conventions')
    lines.push('')
    lines.push(b.conventions.trim())
    lines.push('')
  }

  return lines.join('\n')
}
