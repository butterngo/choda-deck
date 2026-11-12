import * as fs from 'fs'
import * as path from 'path'
import {
  formatReport,
  runEval,
  validateFixture,
  type EvalFixture,
  type EvalPerturb,
  type EvalSearch,
  type EvalSourceLookup
} from '../../core/domain/knowledge-eval/retrieval-eval'

// TASK-3252 — `choda-deck knowledge eval`. Scores the live knowledge_search
// against a labelled query set. The fixture names real slugs, so it is
// validated against the store before a single query runs: a fixture that has
// drifted from the store would report a regression that is not one.
//
// Exit codes: 0 report printed · 1 fixture invalid or search disabled ·
// 2 usage error or missing file.

export const DEFAULT_FIXTURE = path.join('docs', 'knowledge-eval', 'live-queries.json')

export const KNOWLEDGE_HELP = `knowledge eval [--fixture <path>] [--perturb reverse]
  Run the labelled query set through knowledge_search and print recall@1,
  recall@5 and MRR@10 per class, plus the distance profile of each class.
  --fixture   query set (default ${DEFAULT_FIXTURE}, relative to cwd)
  --perturb   reverse = reverse every result list; MRR must drop (proves the
              harness can fail)
knowledge backfill
  Embed every knowledge row whose vector is missing, from another provider,
  or from text that no longer matches its file. Rows whose file is gone are
  listed as orphans and left alone.
`

export interface KnowledgeEvalIo {
  out: (s: string) => void
  err: (s: string) => void
}

export interface KnowledgeEvalDeps {
  search: EvalSearch
  lookup: EvalSourceLookup
  /** Non-null = search is disabled; the reason is printed and the run fails. */
  disabledReason: () => Promise<string | null>
}

export async function knowledgeEvalCommand(
  args: string[],
  io: KnowledgeEvalIo,
  deps: KnowledgeEvalDeps
): Promise<number> {
  let fixturePath = DEFAULT_FIXTURE
  let perturb: EvalPerturb = 'none'
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--fixture' && args[i + 1]) fixturePath = args[++i]
    else if (a === '--perturb' && args[i + 1] === 'reverse') {
      perturb = 'reverse'
      i++
    } else {
      io.err(`error: unknown argument "${a}"\n\n${KNOWLEDGE_HELP}`)
      return 2
    }
  }
  if (!fs.existsSync(fixturePath)) {
    io.err(`file not found: ${fixturePath}\n`)
    return 2
  }
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as EvalFixture

  const errors = await validateFixture(fixture, deps.lookup)
  if (errors.length > 0) {
    io.err(`fixture invalid (${errors.length}):\n${errors.map((e) => `  ${e}`).join('\n')}\n`)
    return 1
  }
  const disabled = await deps.disabledReason()
  if (disabled) {
    io.err(`knowledge_search is disabled: ${disabled}\n`)
    return 1
  }
  io.out(formatReport(await runEval(fixture, deps.search, perturb)))
  return 0
}

export async function dispatchKnowledge(sub: string | undefined, args: string[]): Promise<number> {
  const io: KnowledgeEvalIo = {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s)
  }
  if (sub === 'backfill') {
    const { knowledgeBackfillCommand } = await import('./knowledge-backfill-command')
    return knowledgeBackfillCommand(io)
  }
  if (sub !== 'eval') {
    io.err(
      `error: unknown knowledge subcommand "${sub ?? ''}" — use "knowledge eval" or "knowledge backfill"\n\n${KNOWLEDGE_HELP}`
    )
    return 2
  }
  const { createCliServices } = await import('./service-factory')
  const { svc } = await createCliServices()
  try {
    return await knowledgeEvalCommand(args, io, {
      search: async (query, k) => {
        const r = await svc.searchKnowledge(query, k)
        return r.results.map((h) => ({ slug: h.slug, distance: h.distance }))
      },
      lookup: async (slug) => {
        const src = await svc.readKnowledgeSource(slug)
        return src ? { title: src.frontmatter.title, body: src.body } : null
      },
      disabledReason: async () => {
        const r = await svc.searchKnowledge('probe', 1)
        return r.enabled ? null : (r.reason ?? 'unknown')
      }
    })
  } finally {
    await svc.close()
  }
}
