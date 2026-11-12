import { describe, expect, it } from 'vitest'
import {
  contentWords,
  formatReport,
  recallAtK,
  reciprocalRank,
  runEval,
  validateFixture,
  type EvalFixture,
  type EvalHit,
  type EvalQuery,
  type EvalSourceLookup
} from './retrieval-eval'

const store: Record<string, { title: string; body: string }> = {
  'sync-heartbeat': {
    title: 'Sync loop health is cross-process',
    body: 'Read `loop_last_pull_at` from the heartbeat row.'
  },
  'srcdoc-base': {
    title: 'A srcdoc frame inherits its parent base URL',
    body: 'Use `withSrcdocBase` before writing the frame.'
  },
  'astar-note': { title: 'Algorithm: A* search', body: 'Admissible heuristic.' }
}
const lookup: EvalSourceLookup = async (slug) => store[slug] ?? null

function fixtureOf(counts: {
  identifier: number
  paraphrase: number
  nonsense: number
}): EvalFixture {
  const queries: EvalQuery[] = []
  for (let i = 0; i < counts.identifier; i++) {
    queries.push({
      id: `id-${i}`,
      class: 'identifier',
      query: 'loop_last_pull_at',
      expect: ['sync-heartbeat']
    })
  }
  for (let i = 0; i < counts.paraphrase; i++) {
    queries.push({
      id: `pa-${i}`,
      class: 'paraphrase',
      query: 'shortest route finding',
      expect: ['astar-note']
    })
  }
  for (let i = 0; i < counts.nonsense; i++) {
    queries.push({ id: `no-${i}`, class: 'nonsense', query: 'glorp snarfle', expect: [] })
  }
  return { queries }
}

describe('validateFixture', () => {
  it('accepts a fixture that meets every class rule and count', async () => {
    expect(
      await validateFixture(fixtureOf({ identifier: 10, paraphrase: 10, nonsense: 10 }), lookup)
    ).toEqual([])
  })

  it('rejects too few queries overall and per class', async () => {
    const errors = await validateFixture(
      fixtureOf({ identifier: 9, paraphrase: 10, nonsense: 4 }),
      lookup
    )
    expect(errors).toContain('fixture has 23 queries, needs at least 30')
    expect(errors).toContain('class identifier has 9 queries, needs at least 10')
    expect(errors).toContain('class nonsense has 4 queries, needs at least 5')
  })

  it('rejects an expected slug that is not in the store', async () => {
    const f: EvalFixture = {
      queries: [{ id: 'x', class: 'identifier', query: 'q', expect: ['gone'] }]
    }
    expect(await validateFixture(f, lookup)).toContain(
      'x: expected slug "gone" is not in knowledge_index'
    )
  })

  it('rejects an identifier that does not occur verbatim in its target', async () => {
    const f: EvalFixture = {
      queries: [
        { id: 'x', class: 'identifier', query: 'loopLastPullAt', expect: ['sync-heartbeat'] }
      ]
    }
    expect(await validateFixture(f, lookup)).toContain(
      'x: identifier "loopLastPullAt" does not occur verbatim in sync-heartbeat'
    )
  })

  it('rejects a paraphrase that shares a content word with the target title, ignoring stopwords', async () => {
    const leak: EvalFixture = {
      queries: [
        { id: 'x', class: 'paraphrase', query: 'the frame of a page', expect: ['srcdoc-base'] }
      ]
    }
    expect(await validateFixture(leak, lookup)).toContain(
      'x: paraphrase shares title word(s) frame with srcdoc-base'
    )
    const clean: EvalFixture = {
      queries: [
        {
          id: 'y',
          class: 'paraphrase',
          query: 'the embedded page and its anchors',
          expect: ['srcdoc-base']
        }
      ]
    }
    expect((await validateFixture(clean, lookup)).filter((e) => e.startsWith('y:'))).toEqual([])
  })

  it('rejects a nonsense query that expects a slug, and a duplicate id', async () => {
    const f: EvalFixture = {
      queries: [
        { id: 'n', class: 'nonsense', query: 'zzz', expect: ['astar-note'] },
        { id: 'n', class: 'nonsense', query: 'qqq', expect: [] }
      ]
    }
    const errors = await validateFixture(f, lookup)
    expect(errors).toContain('n: a nonsense query must expect no slug')
    expect(errors).toContain('n: duplicate id')
  })
})

describe('metrics', () => {
  it('recall@k and reciprocal rank match hand-computed values', () => {
    const ranked = ['a', 'b', 'c', 'd']
    const rel = new Set(['b', 'd'])
    expect(recallAtK(ranked, rel, 1)).toBe(0)
    expect(recallAtK(ranked, rel, 2)).toBe(0.5)
    expect(recallAtK(ranked, rel, 4)).toBe(1)
    expect(reciprocalRank(ranked, rel)).toBe(0.5)
    expect(reciprocalRank(['x'], rel)).toBe(0)
  })

  it('contentWords drops short words and stopwords', () => {
    expect([...contentWords('The A* search, with an admissible heuristic')]).toEqual([
      'search',
      'admissible',
      'heuristic'
    ])
  })
})

describe('runEval', () => {
  // Fake store: the expected slug sits at rank `rank` among 10 hits.
  const fixture: EvalFixture = {
    queries: [
      { id: 'i1', class: 'identifier', query: 'q1', expect: ['t1'] },
      { id: 'i2', class: 'identifier', query: 'q2', expect: ['t2'] },
      { id: 'p1', class: 'paraphrase', query: 'q3', expect: ['t3'] },
      { id: 'n1', class: 'nonsense', query: 'q4', expect: [] }
    ]
  }
  const rankOf: Record<string, number> = { q1: 0, q2: 2, q3: 7, q4: -1 }
  const search = async (q: string, k: number): Promise<EvalHit[]> =>
    Array.from({ length: k }, (_, i) => ({
      slug: i === rankOf[q] ? `t${q.slice(1)}` : `filler-${i}`,
      distance: 1 + i * 0.01
    }))

  it('scores each class: recall@1, recall@5, MRR, and the nonsense distance profile', async () => {
    const r = await runEval(fixture, search)
    const id = r.classes.find((c) => c.class === 'identifier')!
    expect(id.recallAt1).toBe(0.5)
    expect(id.recallAt5).toBe(1)
    expect(id.mrr).toBeCloseTo((1 + 1 / 3) / 2)
    const pa = r.classes.find((c) => c.class === 'paraphrase')!
    expect(pa.recallAt5).toBe(0)
    expect(pa.mrr).toBeCloseTo(1 / 8)
    const no = r.classes.find((c) => c.class === 'nonsense')!
    expect(no.mrr).toBeNull()
    expect(no.distance!.top1.median).toBeCloseTo(1)
    expect(no.distance!.medianSpread).toBeCloseTo(0.09)
    expect(r.misses.map((m) => m.id)).toEqual(['p1'])
  })

  it('reversing the ranking lowers MRR — the harness can fail', async () => {
    const good = await runEval(fixture, search)
    const bad = await runEval(fixture, search, 'reverse')
    const mrr = (rep: typeof good): number =>
      rep.classes.find((c) => c.class === 'identifier')!.mrr!
    expect(mrr(bad)).toBeLessThan(mrr(good))
    expect(formatReport(bad)).toContain('perturb reverse')
  })

  it('formats the same report to byte-identical text', async () => {
    const a = formatReport(await runEval(fixture, search))
    const b = formatReport(await runEval(fixture, search))
    expect(a).toBe(b)
    expect(a).toContain('misses at recall@5 (1):')
  })
})
