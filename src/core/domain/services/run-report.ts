import type { Session, Task } from '../task-types'
import { acCoverage, acRows, readAcTicks, type AcCoverage } from '../lifecycle/ac-coverage'
import { addedTestCases, parsePatch, parseSuiteLine, type SuiteTotal } from './added-test-cases'

// TASK-2600 — a goal's test report: what the run's tests prove, in one file the
// companion's Test report tab (TASK-2602) and the PR can both show. Butter,
// 2026-10-21: "có thể có 1 cái report đã test gì, or là regression test".
//
// Deterministic on purpose: everything here is read from what the run already
// stored (handoffs, ac_check events, commits, REALIZES edges). The autopilot only
// adds the smoke results it ran, through `--smoke`.
//
// The frontmatter is YAML whose values are JSON (JSON is valid YAML), so the
// adapter reads it back with JSON.parse per key and needs no YAML library.

export interface SmokeCheck {
  name: string
  call: string
  expect: string
  got: string
  ok: boolean
}

export type Smoke =
  | { env: 'qc' | 'local'; base: string; build: string; ranAt: string; checks: SmokeCheck[]; data: unknown[] }
  | { na: string }

export interface ReportItem {
  task: string
  title: string
  ac: AcCoverage
  testsAdded: number
  /** `testResults.passed[0]` of the item's newest session, verbatim, or null. */
  suiteLine: string | null
}

/** TASK-2637 — one repo's suite: the newest fixed-shape suite line of a session in that workspace. */
export interface WorkspaceSuite extends SuiteTotal {
  workspaceId: string
}

export interface RunReport {
  goal: string
  generatedAt: string
  suite: SuiteTotal | null
  /** One entry per session workspace, ordered by workspaceId; empty when no item session has a suite line. */
  suites: WorkspaceSuite[]
  testsAdded: number
  unreadableCommits: string[]
  ac: AcCoverage
  smoke: Smoke | null
  regression: { task: string; title: string }[]
  items: ReportItem[]
}

export interface RunReportDeps {
  getTask(id: string): Promise<Task | null>
  getSubtasks(id: string): Promise<Task[]>
  findSessions(projectId: string): Promise<Session[]>
  listSessionEvents(sessionId: string, eventType: 'observation'): Promise<{ payloadJson?: string | null; createdAt: string }[]>
  getRelationshipsFrom(id: string, type: 'REALIZES'): Promise<{ toId: string }[]>
  getRelationshipsTo(id: string, type: 'REALIZES'): Promise<{ fromId: string }[]>
  getProject(id: string): Promise<{ cwd: string } | null>
  getWorkspace(id: string): Promise<{ cwd: string } | null>
  /** `git show` patch of one commit in `cwd`, or null when the commit cannot be read there. */
  gitShow(cwd: string, sha: string): string | null
  now(): string
}

const isString = (v: unknown): v is string => typeof v === 'string'

/** The `--smoke` file's two allowed shapes; anything else is not a smoke file. */
export function parseSmoke(text: string): Smoke | null {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (isString(o.na)) return { na: o.na }
  if (o.env !== 'qc' && o.env !== 'local') return null
  if (!isString(o.base) || !isString(o.build) || !isString(o.ranAt)) return null
  if (!Array.isArray(o.checks) || !Array.isArray(o.data)) return null
  const checksOk = o.checks.every((c: unknown) => {
    const x = c as Record<string, unknown>
    return (
      typeof c === 'object' && c !== null &&
      isString(x.name) && isString(x.call) && isString(x.expect) && isString(x.got) && typeof x.ok === 'boolean'
    )
  })
  if (!checksOk) return null
  return {
    env: o.env,
    base: o.base,
    build: o.build,
    ranAt: o.ranAt,
    checks: o.checks as SmokeCheck[],
    data: o.data
  }
}

/** Every descendant of the goal (not the goal itself), by numeric id. Shared with deploy scan (TASK-2604). */
export async function goalTree(deps: Pick<RunReportDeps, 'getSubtasks'>, goalId: string): Promise<Task[]> {
  const out: Task[] = []
  const walk = async (id: string): Promise<void> => {
    for (const t of await deps.getSubtasks(id)) {
      out.push(t)
      await walk(t.id)
    }
  }
  await walk(goalId)
  return out.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
}

const newestFirst = (a: Session, b: Session): number => b.startedAt.localeCompare(a.startedAt)

/** Null when the goal does not exist. */
export async function buildRunReport(
  deps: RunReportDeps,
  goalId: string,
  smoke: Smoke | null
): Promise<RunReport | null> {
  const goal = await deps.getTask(goalId)
  if (!goal) return null
  const items = await goalTree(deps, goalId)
  const inTree = new Set([goalId, ...items.map((t) => t.id)])
  const sessions = (await deps.findSessions(goal.projectId)).sort(newestFirst)
  const project = await deps.getProject(goal.projectId)

  const cwdCache = new Map<string, string | null>()
  const cwdOf = async (workspaceId: string | null | undefined): Promise<string | null> => {
    if (!workspaceId) return project?.cwd ?? null
    if (!cwdCache.has(workspaceId)) cwdCache.set(workspaceId, (await deps.getWorkspace(workspaceId))?.cwd ?? null)
    return cwdCache.get(workspaceId) ?? project?.cwd ?? null
  }

  const total: AcCoverage = { covered: 0, weak: 0, open: 0, human: 0, total: 0 }
  const unreadable: string[] = []
  const seen = new Set<string>()
  let suite: SuiteTotal | null = null
  let suiteAt = ''
  // A goal spanning repos has one suite per repo; `suite` alone showed only the newest one.
  const byWorkspace = new Map<string, { at: string; total: SuiteTotal }>()
  const reportItems: ReportItem[] = []

  for (const task of items) {
    const mine = sessions.filter((s) => s.taskId === task.id)
    const ticks = await readAcTicks((id, type) => deps.listSessionEvents(id, type), task.id, mine.map((s) => s.id))
    const ac = acCoverage(acRows(task.body, ticks))
    for (const k of Object.keys(total) as (keyof AcCoverage)[]) total[k] += ac[k]

    let testsAdded = 0
    for (const s of mine) {
      for (const raw of s.handoff?.commits ?? []) {
        const sha = raw.split(' ')[0]
        if (!sha || seen.has(sha)) continue
        seen.add(sha)
        const cwd = await cwdOf(s.workspaceId)
        const patch = cwd ? deps.gitShow(cwd, sha) : null
        if (patch === null) {
          unreadable.push(sha)
          continue
        }
        testsAdded += addedTestCases(parsePatch(patch)).length
      }
    }

    const withTests = mine.find((s) => s.handoff?.testResults)
    const suiteLine = withTests?.handoff?.testResults?.passed?.[0] ?? null
    for (const s of mine) {
      const line = s.handoff?.testResults?.passed?.[0]
      const parsed = line ? parseSuiteLine(line) : null
      if (parsed && s.startedAt > suiteAt) {
        suite = parsed
        suiteAt = s.startedAt
      }
      const ws = s.workspaceId ?? ''
      if (parsed && ws !== '' && s.startedAt > (byWorkspace.get(ws)?.at ?? '')) {
        byWorkspace.set(ws, { at: s.startedAt, total: parsed })
      }
    }
    reportItems.push({ task: task.id, title: task.title, ac, testsAdded, suiteLine })
  }

  const regression: RunReport['regression'] = []
  const feature = (await deps.getRelationshipsFrom(goalId, 'REALIZES'))[0]?.toId
  if (feature) {
    const ids = (await deps.getRelationshipsTo(feature, 'REALIZES')).map((r) => r.fromId)
    for (const id of [...new Set(ids)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
      if (inTree.has(id)) continue
      const t = await deps.getTask(id)
      if (t?.status === 'DONE') regression.push({ task: t.id, title: t.title })
    }
  }

  return {
    goal: goalId,
    generatedAt: deps.now(),
    suite,
    suites: [...byWorkspace.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([workspaceId, { total }]) => ({ workspaceId, ...total })),
    testsAdded: reportItems.reduce((n, i) => n + i.testsAdded, 0),
    unreadableCommits: unreadable,
    ac: total,
    smoke,
    regression,
    items: reportItems
  }
}

/** `<goal-id lowercased>-test-report.md`, under the goal home workspace's docs/reports. */
export function reportFileName(goalId: string): string {
  return `${goalId.toLowerCase()}-test-report.md`
}

const FRONTMATTER_KEYS = ['goal', 'generatedAt', 'suite', 'testsAdded', 'unreadableCommits', 'ac', 'smoke', 'regression'] as const
/** Written, but not required on read: a report written before TASK-2637 has no `suites` line and must stay readable. */
const OPTIONAL_FRONTMATTER_KEYS = ['suites'] as const

export type ReportFrontmatter = Omit<RunReport, 'items' | 'suites'> & { suites?: WorkspaceSuite[] }

/**
 * TASK-2601 — read a report file's frontmatter back. Null when the block is
 * missing, a line is not `key: <json>`, or a written key is absent.
 */
export function parseReportFrontmatter(text: string): ReportFrontmatter | null {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1]
  if (block === undefined) return null
  const fm: Record<string, unknown> = {}
  for (const line of block.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const i = line.indexOf(': ')
    if (i <= 0) return null
    try {
      fm[line.slice(0, i)] = JSON.parse(line.slice(i + 2))
    } catch {
      return null
    }
  }
  return FRONTMATTER_KEYS.every((k) => k in fm) ? (fm as ReportFrontmatter) : null
}

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

export function renderRunReport(r: RunReport): string {
  const fm = [...FRONTMATTER_KEYS, ...OPTIONAL_FRONTMATTER_KEYS].map((k) => `${k}: ${JSON.stringify(r[k])}`).join('\n')
  const out: string[] = [`---\n${fm}\n---`, '', `# Test report — ${r.goal}`, '', `Generated ${r.generatedAt}.`, '']

  out.push('## Unit and integration suite', '')
  out.push(
    r.suite
      ? `${r.suite.passed} passed, ${r.suite.skipped} skipped, ${r.suite.failed} failed (newest item session with a suite line).`
      : 'No suite line: no item session recorded `full suite: N passed, M skipped, K failed`.'
  )
  if (r.suites.length > 1) {
    out.push('', '| Workspace | Passed | Skipped | Failed |', '|---|---|---|---|')
    for (const w of r.suites) out.push(`| ${cell(w.workspaceId)} | ${w.passed} | ${w.skipped} | ${w.failed} |`)
  }
  out.push('', '## Tests added by this run', '', `${r.testsAdded} test case(s) added across the run's commits.`)
  if (r.unreadableCommits.length) out.push('', `Commits not readable here: ${r.unreadableCommits.join(', ')}.`)

  out.push('', '## Acceptance criteria', '')
  out.push(`${r.ac.covered}/${r.ac.total} covered · ${r.ac.weak} weak · ${r.ac.open} open · ${r.ac.human} waiting on a person.`)

  out.push('', '## Smoke', '')
  if (r.smoke === null) out.push('Not run.')
  else if ('na' in r.smoke) out.push(`n/a — ${r.smoke.na}`)
  else {
    const passed = r.smoke.checks.filter((c) => c.ok).length
    out.push(`${passed}/${r.smoke.checks.length} passed on ${r.smoke.env} (${r.smoke.base}, build ${r.smoke.build}, ran ${r.smoke.ranAt}).`, '')
    out.push('| Check | Call | Expect | Got | Result |', '|---|---|---|---|---|')
    for (const c of r.smoke.checks) {
      out.push(`| ${cell(c.name)} | ${cell(c.call)} | ${cell(c.expect)} | ${cell(c.got)} | ${c.ok ? 'pass' : 'FAIL'} |`)
    }
    if (r.smoke.data.length) out.push('', `Test data created: ${r.smoke.data.map((d) => JSON.stringify(d)).join(', ')}.`)
  }

  out.push('', '## Regression scope', '')
  if (r.regression.length === 0) out.push('No other finished task realizes this goal\'s feature.')
  else for (const t of r.regression) out.push(`- ${t.task} — ${t.title}`)

  out.push('', '## Items', '', '| Task | AC covered | Tests added | Suite line |', '|---|---|---|---|')
  for (const i of r.items) {
    out.push(`| ${i.task} ${cell(i.title)} | ${i.ac.covered}/${i.ac.total} | ${i.testsAdded} | ${cell(i.suiteLine ?? '—')} |`)
  }
  return out.join('\n') + '\n'
}
