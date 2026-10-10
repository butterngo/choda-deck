import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'
import type { ImproveConfig, ImproveCriterion } from './improve-config'

// TASK-2356 — the pure half of `choda-deck improve measure`. Everything here is
// deterministic given its inputs: no browser, no process, no clock, no model.
// The runner (measure-runner.ts) gathers the raw observations and this module
// turns them into the scorecard the skill (TASK-2358) and the companion
// (TASK-2357) read.

/** A page counts as changed when more than this share of its pixels differ. */
export const UI_CHANGED_THRESHOLD = 0.01

export interface TestSummary {
  total: number
  passed: number
  failed: number
  /** passed / total, 0..1, rounded to 3 places; null when nothing ran. */
  passRate: number | null
  /** `file > test` of each failure, as vitest's FAIL lines name them (max 20, deduped). */
  failures: string[]
}

const MAX_FAILURES = 20

export interface PageObservation {
  path: string
  /** Screenshot file name, relative to the day's folder. */
  screenshot: string
  lcpMs: number | null
  consoleErrors: number
  uiChanged: boolean
  /** Share of pixels that differ from the previous screenshot; null when there was none. */
  diffRatio: number | null
}

export interface FlowObservation {
  name: string
  pass: boolean
  durationMs: number | null
  steps: number | null
}

export interface CriterionScore {
  name: string
  by: ImproveCriterion['by']
  measure: string
  target: string | number
  /** Auto criteria get a value; `agent` / `you` stay null for the skill to fill. */
  value: number | boolean | null
  /** Why an auto criterion has no value (an unsupported or unmeasured kind). */
  note?: string
}

export interface Scorecard {
  ws: string
  date: string
  generatedAt: string
  commit: string | null
  tests: TestSummary | null
  pages: PageObservation[]
  flows: FlowObservation[]
  criteria: CriterionScore[]
}

// Strips ANSI colour codes: vitest colours its summary even when piped.
const ANSI = /\u001b\[[0-9;]*m/g

/**
 * Sum every vitest summary line in a test command's output. A workspace test
 * script can run several vitest invocations (`pnpm -r` plus a root config), so
 * the totals add up across all `Tests  …` lines rather than taking the last.
 */
export function parseVitestSummary(output: string): TestSummary | null {
  let passed = 0
  let failed = 0
  let seen = false
  const failures = new Set<string>()
  for (const raw of output.replace(ANSI, '').split(/\r?\n/)) {
    const line = raw.trim()
    const fail = /^FAIL\s+(.+?)\s*$/.exec(line)
    if (fail && failures.size < MAX_FAILURES) failures.add(fail[1])
    if (!/^Tests\s/.test(line)) continue
    seen = true
    passed += Number(/(\d+)\s+passed/.exec(line)?.[1] ?? 0)
    failed += Number(/(\d+)\s+failed/.exec(line)?.[1] ?? 0)
  }
  if (!seen) return null
  const total = passed + failed
  return {
    total,
    passed,
    failed,
    passRate: total ? Math.round((passed / total) * 1000) / 1000 : null,
    failures: [...failures]
  }
}

/**
 * Share of differing pixels between two PNGs. A size change counts as a full
 * change: the layout moved, which is exactly what the loop wants to notice.
 */
export function pngDiffRatio(previous: Buffer, current: Buffer): number {
  const a = PNG.sync.read(previous)
  const b = PNG.sync.read(current)
  if (a.width !== b.width || a.height !== b.height) return 1
  const differing = pixelmatch(a.data, b.data, null, a.width, a.height, { threshold: 0.1 })
  return differing / (a.width * a.height)
}

/** `/#/projects` → `projects`; `/` → `root`. File-name safe and stable across runs. */
export function pageSlug(pagePath: string): string {
  const slug = pagePath
    .replace(/^\/#?\/?/, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
  return slug || 'root'
}

function scoreAuto(
  criterion: ImproveCriterion,
  tests: TestSummary | null,
  pages: PageObservation[],
  flows: FlowObservation[]
): Pick<CriterionScore, 'value' | 'note'> {
  const [kind, ...rest] = criterion.measure.split(':')
  const arg = rest.join(':')
  const page = pages.find((p) => p.path === arg)
  switch (kind) {
    case 'test':
      return tests ? { value: tests.passRate } : { value: null, note: 'no testCmd output' }
    case 'lcp':
      return page ? { value: page.lcpMs } : { value: null, note: `page ${arg} not in pages` }
    case 'console':
      return page
        ? { value: page.consoleErrors }
        : { value: null, note: `page ${arg} not in pages` }
    case 'flow': {
      const flow = flows.find((f) => f.name === arg)
      return flow ? { value: flow.pass } : { value: null, note: `flow ${arg} did not run` }
    }
    default:
      return { value: null, note: `measure kind "${kind}" is not supported by this CLI yet` }
  }
}

export interface ScorecardInput {
  ws: string
  date: string
  generatedAt: string
  commit: string | null
  config: ImproveConfig
  tests: TestSummary | null
  pages: PageObservation[]
  flows: FlowObservation[]
}

export function buildScorecard(input: ScorecardInput): Scorecard {
  const { config, tests, pages, flows } = input
  return {
    ws: input.ws,
    date: input.date,
    generatedAt: input.generatedAt,
    commit: input.commit,
    tests,
    pages,
    flows,
    criteria: config.criteria.map((c) => ({
      name: c.name,
      by: c.by,
      measure: c.measure,
      target: c.target,
      ...(c.by === 'auto' ? scoreAuto(c, tests, pages, flows) : { value: null })
    }))
  }
}
