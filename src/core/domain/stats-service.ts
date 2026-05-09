import type {
  ToolInvocationAggregate,
  ToolInvocationWindow
} from './interfaces/tool-invocations-repository.interface'

// V0 classification thresholds — locked in CONV-1778305062379-3.
// Floor of 5 calls suppresses noise on sparse data: a tool with 1 error in 1
// call is not "broken", it's "emerging". Floor applies to broken AND mvp.
const FLOOR_CALLS = 5
const BROKEN_ERROR_RATE = 0.2
const MVP_ERROR_RATE = 0.05
const MVP_TOP_FRACTION = 0.25

export type StatsClassification = 'mvp' | 'broken' | 'dead-in-window' | 'emerging'

export interface ToolStat {
  tool: string
  calls: number
  errorRate: number
  avgDurationMs: number
  lastUsedAt: string | null
  classification: StatsClassification
}

export interface StatsReport {
  period: ToolInvocationWindow
  totalCalls: number
  perTool: ToolStat[]
  deadInWindow: string[]
  brokenTools: string[]
}

export interface ComputeStatsInput {
  rows: ToolInvocationAggregate[]
  canonical: ReadonlyArray<string>
  period: ToolInvocationWindow
}

export function computeStatsReport(input: ComputeStatsInput): StatsReport {
  const merged = mergeWithCanonical(input.rows, input.canonical)
  const totalCalls = merged.reduce((sum, t) => sum + t.calls, 0)
  const mvpThreshold = computeMvpThreshold(merged)

  const perTool: ToolStat[] = merged.map((t) => ({
    tool: t.tool,
    calls: t.calls,
    errorRate: t.calls === 0 ? 0 : t.errors / t.calls,
    avgDurationMs: t.avgDurationMs,
    lastUsedAt: t.lastUsedAt,
    classification: classify(t, mvpThreshold)
  }))

  // Sort: most-called first, ties broken by name for stable output.
  perTool.sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool))

  return {
    period: input.period,
    totalCalls,
    perTool,
    deadInWindow: perTool.filter((t) => t.classification === 'dead-in-window').map((t) => t.tool),
    brokenTools: perTool.filter((t) => t.classification === 'broken').map((t) => t.tool)
  }
}

interface MergedTool {
  tool: string
  calls: number
  errors: number
  avgDurationMs: number
  lastUsedAt: string | null
}

function mergeWithCanonical(
  rows: ToolInvocationAggregate[],
  canonical: ReadonlyArray<string>
): MergedTool[] {
  const seen = new Map<string, MergedTool>()
  for (const r of rows) {
    seen.set(r.tool, {
      tool: r.tool,
      calls: r.calls,
      errors: r.errors,
      avgDurationMs: r.avgDurationMs,
      lastUsedAt: r.lastUsedAt
    })
  }
  for (const name of canonical) {
    if (!seen.has(name)) {
      seen.set(name, {
        tool: name,
        calls: 0,
        errors: 0,
        avgDurationMs: 0,
        lastUsedAt: null
      })
    }
  }
  return Array.from(seen.values())
}

// Top 25% of tools by call count among tools that were actually called.
// Returns the minimum call count to be considered "top". Returns Infinity if
// no tools were called (no tool can satisfy mvp).
function computeMvpThreshold(merged: MergedTool[]): number {
  const active = merged.filter((t) => t.calls > 0).map((t) => t.calls)
  if (active.length === 0) return Infinity
  active.sort((a, b) => b - a)
  const topN = Math.max(1, Math.ceil(active.length * MVP_TOP_FRACTION))
  return active[topN - 1]
}

function classify(t: MergedTool, mvpThreshold: number): StatsClassification {
  if (t.calls === 0) return 'dead-in-window'
  const errorRate = t.errors / t.calls
  if (t.calls >= FLOOR_CALLS && errorRate > BROKEN_ERROR_RATE) return 'broken'
  if (t.calls >= FLOOR_CALLS && errorRate < MVP_ERROR_RATE && t.calls >= mvpThreshold) {
    return 'mvp'
  }
  return 'emerging'
}
