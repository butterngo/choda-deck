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
import {
  sweepCuts,
  type RelevanceSignals,
  type SweepRow
} from '../../core/domain/embedding/relevance'

// TASK-3252 — `choda-deck knowledge eval`. Scores the live knowledge_search
// against a labelled query set. The fixture names real slugs, so it is
// validated against the store before a single query runs: a fixture that has
// drifted from the store would report a regression that is not one.
//
// Exit codes: 0 report printed · 1 fixture invalid or search disabled ·
// 2 usage error or missing file.

export const DEFAULT_FIXTURE = path.join('docs', 'knowledge-eval', 'live-queries.json')

export const KNOWLEDGE_HELP = `knowledge eval [--fixture <path>] [--perturb reverse] [--sweep]
  Run the labelled query set through knowledge_search and print recall@1,
  recall@5 and MRR@10 per class, plus the distance profile of each class.
  --fixture   query set (default ${DEFAULT_FIXTURE}, relative to cwd)
  --perturb   reverse = reverse every result list; MRR must drop (proves the
              harness can fail)
  --sweep     print each query's no-match signals and the false-positive /
              false-negative count of every cut (TASK-1622)
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
  /** TASK-1622 — the no-match signals of one query, for `--sweep`. */
  signals?: (query: string) => Promise<RelevanceSignals>
}

// TASK-1622 — the no-match cuts `--sweep` tries: every 0.01 over the range the
// nearest distances of this store fall in (0.92-1.29 on 2026-11-12).
const SWEEP_CUTS = Array.from({ length: 51 }, (_, i) => Math.round((0.85 + i * 0.01) * 100) / 100)

export function formatSweep(rows: SweepRow[]): string {
  const lines = ['query       should  nearest  lexical']
  for (const r of rows) {
    const d = r.signals.nearestDistance
    lines.push(
      `${r.id.padEnd(11)} ${(r.shouldMatch ? 'match' : 'miss').padEnd(6)}  ${d === null ? '    -' : d.toFixed(3)}    ${r.signals.lexicalMatches}`
    )
  }
  lines.push('', 'rule                  cut    FP  FN')
  for (const l of sweepCuts(rows, SWEEP_CUTS)) {
    lines.push(
      `${l.rule.padEnd(20)}  ${l.cut.toFixed(2)}  ${String(l.falsePositives).padStart(3)} ${String(l.falseNegatives).padStart(3)}`
    )
  }
  return lines.join('\n') + '\n'
}

export async function knowledgeEvalCommand(
  args: string[],
  io: KnowledgeEvalIo,
  deps: KnowledgeEvalDeps
): Promise<number> {
  let fixturePath = DEFAULT_FIXTURE
  let perturb: EvalPerturb = 'none'
  let sweep = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--sweep') sweep = true
    else if (a === '--fixture' && args[i + 1]) fixturePath = args[++i]
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
  if (sweep) {
    if (!deps.signals) {
      io.err('--sweep needs a search that reports its no-match signals\n')
      return 2
    }
    const rows: SweepRow[] = []
    for (const q of fixture.queries) {
      rows.push({
        id: q.id,
        shouldMatch: q.class !== 'nonsense',
        signals: await deps.signals(q.query)
      })
    }
    io.out(formatSweep(rows))
    return 0
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
      },
      signals: async (query) => {
        const r = await svc.searchKnowledge(query, 10)
        return { nearestDistance: r.nearestDistance ?? null, lexicalMatches: r.lexicalMatches ?? 0 }
      }
    })
  } finally {
    await svc.close()
  }
}
