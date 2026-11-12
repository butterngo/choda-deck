import { resolveDataPaths } from '../../core/paths'
import { checkKnowledgeDatabase } from '../../core/domain/embedding/knowledge-check-db'
import {
  formatKnowledgeCheck,
  knowledgeCheckClean
} from '../../core/domain/embedding/knowledge-check'

// TASK-3267 — `choda-deck knowledge check [--json]`. Reports, never repairs:
// deleting an orphan row or rewriting a note is a decision on live data.
//
// Exit codes: 0 nothing to report · 1 something to report · 2 usage.

export async function knowledgeCheckCommand(
  args: string[],
  io: { out: (s: string) => void; err: (s: string) => void },
  dbPath: string = resolveDataPaths().dbPath
): Promise<number> {
  const json = args.includes('--json')
  const unknown = args.find((a) => a !== '--json')
  if (unknown) {
    io.err(`error: unknown argument "${unknown}" — usage: knowledge check [--json]\n`)
    return 2
  }
  const report = await checkKnowledgeDatabase(dbPath)
  io.out(
    json ? JSON.stringify(report, null, 2) + '\n' : `db: ${dbPath}\n${formatKnowledgeCheck(report)}`
  )
  return knowledgeCheckClean(report) ? 0 : 1
}
