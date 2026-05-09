import { describe, it, expect } from 'vitest'
import { computeStatsReport } from '../stats-service'
import type {
  ToolInvocationAggregate,
  ToolInvocationWindow
} from '../interfaces/tool-invocations-repository.interface'

const NULL_PERIOD: ToolInvocationWindow = { since: null, until: null }

function row(
  tool: string,
  calls: number,
  errors: number,
  lastUsedAt = '2026-05-09T00:00:00.000Z'
): ToolInvocationAggregate {
  return { tool, calls, errors, avgDurationMs: 1, lastUsedAt }
}

describe('computeStatsReport', () => {
  it('empty input returns zero-state shape', () => {
    const r = computeStatsReport({ rows: [], canonical: [], period: NULL_PERIOD })
    expect(r).toEqual({
      period: NULL_PERIOD,
      totalCalls: 0,
      perTool: [],
      deadInWindow: [],
      brokenTools: []
    })
  })

  it('echoes the period in the result', () => {
    const period = { since: '2026-05-01T00:00:00Z', until: '2026-05-09T23:59:59Z' }
    const r = computeStatsReport({ rows: [], canonical: [], period })
    expect(r.period).toEqual(period)
  })

  it('AC-7: tool registered but never called → dead-in-window, calls=0, lastUsedAt=null', () => {
    const r = computeStatsReport({
      rows: [],
      canonical: ['unused_tool'],
      period: NULL_PERIOD
    })
    expect(r.perTool).toHaveLength(1)
    expect(r.perTool[0]).toMatchObject({
      tool: 'unused_tool',
      calls: 0,
      errorRate: 0,
      lastUsedAt: null,
      classification: 'dead-in-window'
    })
    expect(r.deadInWindow).toEqual(['unused_tool'])
  })

  it('classifies broken: calls>=5 AND errorRate>0.2', () => {
    const r = computeStatsReport({
      rows: [row('flaky', 10, 3)], // 30% error rate
      canonical: ['flaky'],
      period: NULL_PERIOD
    })
    expect(r.perTool[0].classification).toBe('broken')
    expect(r.brokenTools).toEqual(['flaky'])
  })

  it('does NOT classify as broken below the call floor (calls<5)', () => {
    const r = computeStatsReport({
      rows: [row('sparse', 4, 4)], // 100% error rate but only 4 calls
      canonical: ['sparse'],
      period: NULL_PERIOD
    })
    expect(r.perTool[0].classification).toBe('emerging')
    expect(r.brokenTools).toEqual([])
  })

  it('classifies mvp: top 25% calls AND calls>=5 AND errorRate<0.05', () => {
    // 4 tools — top 25% = top 1 (the "winner"). Winner has 100 calls, 0 errors.
    const r = computeStatsReport({
      rows: [row('winner', 100, 0), row('mid', 50, 0), row('low', 10, 0), row('tiny', 5, 0)],
      canonical: ['winner', 'mid', 'low', 'tiny'],
      period: NULL_PERIOD
    })
    const winner = r.perTool.find((t) => t.tool === 'winner')!
    expect(winner.classification).toBe('mvp')
    // Others below the top-25% threshold should be emerging.
    expect(r.perTool.find((t) => t.tool === 'mid')!.classification).toBe('emerging')
  })

  it('top 25% but errorRate >= 0.05 → emerging, not mvp', () => {
    const r = computeStatsReport({
      rows: [row('top_with_errors', 100, 5)], // exactly 5% — fails strict <0.05
      canonical: ['top_with_errors'],
      period: NULL_PERIOD
    })
    expect(r.perTool[0].classification).toBe('emerging')
  })

  it('top 25% but below floor → emerging, not mvp', () => {
    // Only one tool active → it's "top 25%" trivially, but only 4 calls < floor.
    const r = computeStatsReport({
      rows: [row('young', 4, 0)],
      canonical: ['young'],
      period: NULL_PERIOD
    })
    expect(r.perTool[0].classification).toBe('emerging')
  })

  it('dead-in-window precedence: calls=0 always wins over other rules', () => {
    const r = computeStatsReport({
      rows: [],
      canonical: ['ghost'],
      period: NULL_PERIOD
    })
    expect(r.perTool[0].classification).toBe('dead-in-window')
  })

  it('totals + sorting: sums calls across rows and sorts perTool by calls desc', () => {
    const r = computeStatsReport({
      rows: [row('a', 3, 0), row('b', 10, 0), row('c', 1, 0)],
      canonical: ['a', 'b', 'c'],
      period: NULL_PERIOD
    })
    expect(r.totalCalls).toBe(14)
    expect(r.perTool.map((t) => t.tool)).toEqual(['b', 'a', 'c'])
  })

  it('combines all classifications cleanly in one report', () => {
    // 8 active tools — top 25% = top 2. Threshold = 80 calls (the 2nd-highest).
    const rows = [
      row('mvp1', 200, 0), // mvp
      row('mvp2', 80, 1), // 1.25% errors, calls>=5, top-2 → mvp
      row('broken1', 50, 20), // 40% errors → broken
      row('emerging1', 30, 0), // not in top 2 → emerging
      row('emerging2', 6, 0), // not in top 2 → emerging
      row('sparse', 2, 1) // below floor → emerging
    ]
    const r = computeStatsReport({
      rows,
      canonical: ['mvp1', 'mvp2', 'broken1', 'emerging1', 'emerging2', 'sparse', 'never'],
      period: NULL_PERIOD
    })
    const byName = Object.fromEntries(r.perTool.map((t) => [t.tool, t.classification]))
    expect(byName).toEqual({
      mvp1: 'mvp',
      mvp2: 'mvp',
      broken1: 'broken',
      emerging1: 'emerging',
      emerging2: 'emerging',
      sparse: 'emerging',
      never: 'dead-in-window'
    })
    expect(r.deadInWindow).toEqual(['never'])
    expect(r.brokenTools).toEqual(['broken1'])
  })
})
