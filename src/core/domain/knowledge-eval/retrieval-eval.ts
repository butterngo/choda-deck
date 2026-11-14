// TASK-3252 — a fixed, labelled query set for knowledge_search, so a change to
// ranking (hybrid search TASK-3253, threshold TASK-1622, q8 model TASK-3203) is
// judged by a number instead of by eye. Pure: the search is injected, so the
// same code scores the live store from the CLI and a fake one in tests.

export type EvalQueryClass = 'identifier' | 'paraphrase' | 'nonsense'

export interface EvalQuery {
  id: string
  class: EvalQueryClass
  query: string
  /** Slugs a correct answer must contain. Empty for `nonsense` — the right answer is "no match". */
  expect: string[]
}

export interface EvalFixture {
  queries: EvalQuery[]
}

export interface EvalHit {
  slug: string
  distance?: number | null
}

export type EvalSearch = (query: string, k: number) => Promise<EvalHit[]>

/** What the validator needs to know about an expected slug; null = not in the store. */
export type EvalSourceLookup = (slug: string) => Promise<{ title: string; body: string } | null>

export const MIN_QUERIES = 30
export const MIN_PER_CLASS: Record<EvalQueryClass, number> = {
  identifier: 10,
  paraphrase: 10,
  nonsense: 5
}

// MRR is cut at 10: past the first screen a hit is as good as a miss for a reader.
export const EVAL_DEPTH = 10

const STOPWORDS = new Set(
  'the and for with that this from are was were its not but into when then than only also can has have had will would should could does did any all one two out own our you your his her their them they who what why how which while where after before over under about between there here more most less such just very'.split(
    ' '
  )
)

/** Content words: lowercase letter/digit runs of 3+ chars, minus common English stopwords. */
export function contentWords(s: string): Set<string> {
  const words = s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  return new Set(words.filter((w) => w.length >= 3 && !STOPWORDS.has(w)))
}

/**
 * Every rule here is what makes a class mean what its name says. An identifier
 * query that does not occur in its target tests nothing lexical; a paraphrase
 * that shares a title word is half an identifier query; a "nonsense" query with
 * an expected slug is not nonsense.
 */
export async function validateFixture(
  fixture: EvalFixture,
  lookup: EvalSourceLookup
): Promise<string[]> {
  const errors: string[] = []
  const ids = new Set<string>()
  const count: Record<EvalQueryClass, number> = { identifier: 0, paraphrase: 0, nonsense: 0 }
  for (const q of fixture.queries) {
    if (ids.has(q.id)) errors.push(`${q.id}: duplicate id`)
    ids.add(q.id)
    if (!(q.class in count)) {
      errors.push(`${q.id}: unknown class "${q.class}"`)
      continue
    }
    count[q.class]++
    if (q.class === 'nonsense') {
      if (q.expect.length > 0) errors.push(`${q.id}: a nonsense query must expect no slug`)
      continue
    }
    if (q.expect.length === 0) errors.push(`${q.id}: expects no slug`)
    for (const slug of q.expect) {
      let src: { title: string; body: string } | null
      try {
        src = await lookup(slug)
      } catch (err) {
        // One unreadable entry is a finding about that entry, not a reason to
        // hide every other error in the fixture.
        errors.push(`${q.id}: ${slug} could not be read: ${(err as Error).message}`)
        continue
      }
      if (!src) {
        errors.push(`${q.id}: expected slug "${slug}" is not in knowledge_index`)
        continue
      }
      if (q.class === 'identifier' && !src.body.includes(q.query)) {
        errors.push(`${q.id}: identifier "${q.query}" does not occur verbatim in ${slug}`)
      }
      if (q.class === 'paraphrase') {
        const title = contentWords(src.title)
        const shared = [...contentWords(q.query)].filter((w) => title.has(w))
        if (shared.length > 0) {
          errors.push(`${q.id}: paraphrase shares title word(s) ${shared.join(', ')} with ${slug}`)
        }
      }
    }
  }
  if (fixture.queries.length < MIN_QUERIES) {
    errors.push(`fixture has ${fixture.queries.length} queries, needs at least ${MIN_QUERIES}`)
  }
  for (const c of Object.keys(MIN_PER_CLASS) as EvalQueryClass[]) {
    if (count[c] < MIN_PER_CLASS[c]) {
      errors.push(`class ${c} has ${count[c]} queries, needs at least ${MIN_PER_CLASS[c]}`)
    }
  }
  return errors
}

export function recallAtK(ranked: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 1
  let hit = 0
  for (const slug of ranked.slice(0, k)) if (relevant.has(slug)) hit++
  return hit / relevant.size
}

export function reciprocalRank(ranked: string[], relevant: Set<string>): number {
  const i = ranked.findIndex((slug) => relevant.has(slug))
  return i < 0 ? 0 : 1 / (i + 1)
}

export interface DistanceProfile {
  /** Distance of the best hit, summarised across the class's queries. */
  top1: { min: number; median: number; max: number }
  /** Median over queries of (last − first) distance in the returned list. */
  medianSpread: number
}

export interface ClassReport {
  class: EvalQueryClass
  queries: number
  recallAt1: number | null
  recallAt5: number | null
  mrr: number | null
  distance: DistanceProfile | null
}

export interface EvalReport {
  depth: number
  perturb: EvalPerturb
  classes: ClassReport[]
  misses: { id: string; query: string; expect: string[]; got: string[] }[]
}

/**
 * `reverse` exists to prove the harness can fail: reversing the returned order
 * must lower MRR. A harness whose numbers survive that measures nothing.
 */
export type EvalPerturb = 'none' | 'reverse'

const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function profile(lists: EvalHit[][]): DistanceProfile | null {
  const withDist = lists.filter(
    (l) => l.length > 0 && l.every((h) => typeof h.distance === 'number')
  )
  if (withDist.length === 0) return null
  const top1 = withDist.map((l) => l[0].distance!)
  return {
    top1: { min: Math.min(...top1), median: median(top1), max: Math.max(...top1) },
    medianSpread: median(withDist.map((l) => l[l.length - 1].distance! - l[0].distance!))
  }
}

export async function runEval(
  fixture: EvalFixture,
  search: EvalSearch,
  perturb: EvalPerturb = 'none'
): Promise<EvalReport> {
  const byClass = new Map<EvalQueryClass, { q: EvalQuery; hits: EvalHit[] }[]>()
  const misses: EvalReport['misses'] = []
  for (const q of fixture.queries) {
    let hits = (await search(q.query, EVAL_DEPTH)).slice(0, EVAL_DEPTH)
    if (perturb === 'reverse') hits = [...hits].reverse()
    const row = byClass.get(q.class) ?? []
    row.push({ q, hits })
    byClass.set(q.class, row)
    const ranked = hits.map((h) => h.slug)
    if (q.class !== 'nonsense' && recallAtK(ranked, new Set(q.expect), 5) < 1) {
      misses.push({ id: q.id, query: q.query, expect: q.expect, got: ranked.slice(0, 5) })
    }
  }
  const classes: ClassReport[] = []
  for (const c of ['identifier', 'paraphrase', 'nonsense'] as EvalQueryClass[]) {
    const rows = byClass.get(c)
    if (!rows) continue
    const scored = c !== 'nonsense'
    const metric = (f: (ranked: string[], rel: Set<string>) => number): number | null =>
      scored
        ? mean(
            rows.map((r) =>
              f(
                r.hits.map((h) => h.slug),
                new Set(r.q.expect)
              )
            )
          )
        : null
    classes.push({
      class: c,
      queries: rows.length,
      recallAt1: metric((r, s) => recallAtK(r, s, 1)),
      recallAt5: metric((r, s) => recallAtK(r, s, 5)),
      mrr: metric(reciprocalRank),
      distance: profile(rows.map((r) => r.hits))
    })
  }
  return { depth: EVAL_DEPTH, perturb, classes, misses }
}

const f3 = (x: number | null): string => (x === null ? '    -' : x.toFixed(3))

/** Fixed decimals and fixed order: two runs on an unchanged store print byte-identical text. */
export function formatReport(report: EvalReport): string {
  const lines = [
    `knowledge_search eval — depth ${report.depth}, perturb ${report.perturb}`,
    'class        n   recall@1  recall@5  MRR@10   top1 dist min/med/max   spread',
    ...report.classes.map((c) => {
      const d = c.distance
      const dist = d
        ? `${f3(d.top1.min)}/${f3(d.top1.median)}/${f3(d.top1.max)}   ${f3(d.medianSpread)}`
        : '-'
      return `${c.class.padEnd(11)} ${String(c.queries).padStart(2)}   ${f3(c.recallAt1)}     ${f3(c.recallAt5)}     ${f3(c.mrr)}    ${dist}`
    })
  ]
  if (report.misses.length > 0) {
    lines.push('', `misses at recall@5 (${report.misses.length}):`)
    for (const m of report.misses) {
      lines.push(`  ${m.id} "${m.query}" expected ${m.expect.join(', ')}; got ${m.got.join(', ')}`)
    }
  }
  return `${lines.join('\n')}\n`
}
