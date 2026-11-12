// TASK-1622 — whether a knowledge_search result set holds a confident match.
// Results are never hidden: a flag lets a client say "nearest" instead of
// "results" without losing a real hit (the decision recorded in TASK-1622).

export interface RelevanceSignals {
  /** Vector-leg top-1 distance (nearest chunk), or null with no vector hit. */
  nearestDistance: number | null
  /** How many entries the lexical leg matched (it reads at most its depth). */
  lexicalMatches: number
}

// Swept 2026-11-12 with `choda-deck knowledge eval --sweep` over the TASK-3252
// set (24 should-match, 6 should-miss) on the goal snapshot with hybrid search
// and chunked q8 vectors. Nearest distance: should-match max 1.130 (ident-07),
// should-miss min 1.146 (none-03).
//   cut 1.12  FP 0  FN 1
//   cut 1.13  FP 0  FN 0
//   cut 1.14  FP 0  FN 0   <- chosen: the far end of the clean band, since
//                              flagging a real hit costs more than a weak one
//   cut 1.15  FP 1  FN 0
// "lexical leg matched anything" is not a signal: nonsense words such as
// `lorem ipsum` and `banana` match prose, so OR-ing it in gave FP 3 at every
// cut. The margin is 0.016 on 30 queries — re-sweep when the set or the
// embedding changes.
export const NO_MATCH_DISTANCE = 1.14

/** A query has a confident match when its nearest vector is within NO_MATCH_DISTANCE. */
export function hasConfidentMatch(s: RelevanceSignals): boolean {
  return s.nearestDistance !== null && s.nearestDistance <= NO_MATCH_DISTANCE
}

export interface SweepRow {
  id: string
  shouldMatch: boolean
  signals: RelevanceSignals
}

export interface SweepLine {
  rule: 'distance' | 'distance-or-lexical'
  cut: number
  falsePositives: number
  falseNegatives: number
}

/**
 * For each cut, how a rule labels the swept queries. A false negative is a
 * should-match query marked noConfidentMatch (the costly error: it tells the
 * user a real hit is not one); a false positive is a should-miss query marked
 * confident.
 */
export function sweepCuts(rows: SweepRow[], cuts: number[]): SweepLine[] {
  const lines: SweepLine[] = []
  for (const rule of ['distance', 'distance-or-lexical'] as const) {
    for (const cut of cuts) {
      let fp = 0
      let fn = 0
      for (const r of rows) {
        const near = r.signals.nearestDistance !== null && r.signals.nearestDistance <= cut
        const confident = rule === 'distance' ? near : near || r.signals.lexicalMatches > 0
        if (r.shouldMatch && !confident) fn++
        if (!r.shouldMatch && confident) fp++
      }
      lines.push({ rule, cut, falsePositives: fp, falseNegatives: fn })
    }
  }
  return lines
}
