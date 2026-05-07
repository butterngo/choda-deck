import { parseArgs } from 'node:util'
import {
  KNOWLEDGE_SCOPES,
  KNOWLEDGE_TYPES
} from '../../../core/domain/knowledge-types'
import type {
  KnowledgeListFilter,
  KnowledgeListItem,
  KnowledgeScope,
  KnowledgeType
} from '../../../core/domain/knowledge-types'
import { createCliServices } from '../service-factory'
import { renderJson } from '../render/json'
import { renderTable } from '../render/plain'

export const knowledgeListHelp = `Usage: choda-deck knowledge list [options]

Options:
  --project <id>     Filter by project ID
  --workspace <id>   Filter by workspace ID (use "global" for null workspace)
  --scope <s>        ${KNOWLEDGE_SCOPES.join(' | ')}
  --type <t>         ${KNOWLEDGE_TYPES.join(' | ')}
  --json             Emit JSON instead of plain text
`

export async function runKnowledgeList(argv: string[]): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    options: {
      project: { type: 'string' },
      workspace: { type: 'string' },
      scope: { type: 'string' },
      type: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false }
    },
    allowPositionals: false,
    strict: true
  })

  const v = parsed.values
  if (v.help) {
    process.stdout.write(knowledgeListHelp)
    return 0
  }

  if (v.scope && !KNOWLEDGE_SCOPES.includes(v.scope as KnowledgeScope)) {
    process.stderr.write(`error: invalid --scope "${v.scope}". Must be one of: ${KNOWLEDGE_SCOPES.join(', ')}\n`)
    return 2
  }
  if (v.type && !KNOWLEDGE_TYPES.includes(v.type as KnowledgeType)) {
    process.stderr.write(`error: invalid --type "${v.type}". Must be one of: ${KNOWLEDGE_TYPES.join(', ')}\n`)
    return 2
  }

  const filter: KnowledgeListFilter = {
    projectId: v.project,
    workspaceId: v.workspace === 'global' ? null : v.workspace,
    scope: v.scope as KnowledgeScope | undefined,
    type: v.type as KnowledgeType | undefined
  }

  const { svc } = await createCliServices()
  const results: KnowledgeListItem[] = svc.listKnowledge(filter)

  if (v.json) {
    process.stdout.write(renderJson(results) + '\n')
    return 0
  }

  process.stdout.write(
    renderTable(results, [
      { header: 'SLUG', get: (k) => k.slug, width: 28 },
      { header: 'TYPE', get: (k) => k.type, width: 8 },
      { header: 'SCOPE', get: (k) => k.scope, width: 9 },
      { header: 'PROJECT', get: (k) => k.projectId, width: 14 },
      { header: 'WORKSPACE', get: (k) => k.workspaceId ?? '-', width: 14 },
      { header: 'TITLE', get: (k) => k.title }
    ])
  )
  return 0
}
