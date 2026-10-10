import * as fs from 'fs'
import * as path from 'path'
import { loadImproveConfig, type ImproveConfig } from './improve-config'
import {
  UI_CHANGED_THRESHOLD,
  buildScorecard,
  pageSlug,
  parseVitestSummary,
  pngDiffRatio,
  type FlowObservation,
  type PageObservation,
  type Scorecard
} from './measure-engine'

// TASK-2356 — the I/O half of `choda-deck improve measure`. It orchestrates:
// start the app if it is down, run the tests, capture each page, run each flow,
// diff today's screenshots against the previous ones, write the scorecard. The
// browser and the shell are injected (the CLI adapter supplies Playwright and
// child_process), so tests drive it with fakes and nothing here launches a
// browser or calls a model.

export const RETENTION_DAYS = 90
export const START_TIMEOUT_MS = 60_000

export interface PageCapture {
  png: Buffer
  lcpMs: number | null
  consoleErrors: number
}

export interface PageDriver {
  /** Optional: load every page once, untimed, so the first measured page is not paying a cold compile. */
  warmUp?(urls: string[]): Promise<void>
  capture(url: string): Promise<PageCapture>
  close(): Promise<void>
}

export interface CommandResult {
  code: number | null
  output: string
}

export interface StartedProcess {
  stop(): Promise<void>
}

export interface MeasureShell {
  run(cmd: string, cwd: string, env?: Record<string, string>): Promise<CommandResult>
  start(cmd: string, cwd: string): StartedProcess
}

export interface MeasureDeps {
  openDriver(): Promise<PageDriver>
  shell: MeasureShell
  reachable(url: string): Promise<boolean>
  sleep(ms: number): Promise<void>
  now(): Date
}

export interface MeasureRequest {
  ws: string
  cwd: string
  artifactsDir: string
  /** Local calendar date for the files, YYYY-MM-DD. */
  date: string
}

export type MeasureResult =
  | { status: 'off'; reason: string }
  | { status: 'written'; file: string; scorecard: Scorecard; startedApp: boolean }

export function improveArtifactsDir(artifactsDir: string, ws: string): string {
  return path.join(artifactsDir, 'improve', ws)
}

async function ensureApp(
  config: ImproveConfig,
  cwd: string,
  deps: MeasureDeps
): Promise<StartedProcess | null> {
  if (await deps.reachable(config.url)) return null
  if (!config.startCmd) {
    throw new Error(`${config.url} is not answering and the config has no startCmd`)
  }
  const proc = deps.shell.start(config.startCmd, cwd)
  const deadline = deps.now().getTime() + START_TIMEOUT_MS
  while (deps.now().getTime() < deadline) {
    if (await deps.reachable(config.url)) return proc
    await deps.sleep(1000)
  }
  await proc.stop()
  throw new Error(
    `${config.url} did not answer within ${START_TIMEOUT_MS / 1000}s of "${config.startCmd}"`
  )
}

/** The newest earlier screenshot of this page, or today's own when re-running the same day. */
function previousScreenshot(dir: string, date: string, file: string): Buffer | null {
  const today = path.join(dir, date, file)
  if (fs.existsSync(today)) return fs.readFileSync(today)
  let days: string[]
  try {
    days = fs.readdirSync(dir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < date)
  } catch {
    return null
  }
  for (const d of days.sort().reverse()) {
    const p = path.join(dir, d, file)
    if (fs.existsSync(p)) return fs.readFileSync(p)
  }
  return null
}

async function capturePages(
  config: ImproveConfig,
  dir: string,
  date: string,
  deps: MeasureDeps
): Promise<PageObservation[]> {
  const driver = await deps.openDriver()
  const pages: PageObservation[] = []
  const urlOf = (p: string): string => config.url.replace(/\/+$/, '') + p
  try {
    await driver.warmUp?.(config.pages.map(urlOf))
    for (const pagePath of config.pages) {
      const capture = await driver.capture(urlOf(pagePath))
      const file = `${pageSlug(pagePath)}.png`
      const previous = previousScreenshot(dir, date, file)
      const diffRatio = previous ? pngDiffRatio(previous, capture.png) : null
      fs.mkdirSync(path.join(dir, date), { recursive: true })
      fs.writeFileSync(path.join(dir, date, file), capture.png)
      pages.push({
        path: pagePath,
        screenshot: `${date}/${file}`,
        lcpMs: capture.lcpMs === null ? null : Math.round(capture.lcpMs),
        consoleErrors: capture.consoleErrors,
        // No previous screenshot means nothing to compare: the first run is a change.
        uiChanged: diffRatio === null || diffRatio > UI_CHANGED_THRESHOLD,
        diffRatio: diffRatio === null ? null : Math.round(diffRatio * 10000) / 10000
      })
    }
  } finally {
    await driver.close()
  }
  return pages
}

/** The directory holding the nearest playwright.config.* at or above the spec, within cwd. */
export function playwrightRoot(cwd: string, spec: string): string {
  let dir = path.dirname(path.resolve(cwd, spec))
  const stop = path.resolve(cwd)
  for (;;) {
    if (
      ['ts', 'js', 'mjs', 'cjs'].some((ext) =>
        fs.existsSync(path.join(dir, `playwright.config.${ext}`))
      )
    ) {
      return dir
    }
    if (dir === stop || path.dirname(dir) === dir) return stop
    dir = path.dirname(dir)
  }
}

interface PlaywrightJsonTest {
  annotations?: { type: string; description?: string }[]
  results?: {
    status?: string
    duration?: number
    annotations?: { type: string; description?: string }[]
  }[]
}

interface PlaywrightJsonSuite {
  specs?: { tests?: PlaywrightJsonTest[] }[]
  suites?: PlaywrightJsonSuite[]
}

/** Pass + timing for one flow from a Playwright JSON report. */
export function parsePlaywrightReport(name: string, json: unknown): FlowObservation {
  const tests: PlaywrightJsonTest[] = []
  const walk = (s: PlaywrightJsonSuite): void => {
    for (const spec of s.specs ?? []) tests.push(...(spec.tests ?? []))
    for (const child of s.suites ?? []) walk(child)
  }
  for (const s of (json as { suites?: PlaywrightJsonSuite[] })?.suites ?? []) walk(s)
  if (tests.length === 0) return { name, pass: false, durationMs: null, steps: null }
  const results = tests.map((t) => t.results?.[t.results.length - 1])
  const pass = results.every((r) => r?.status === 'passed')
  const annotations = tests.flatMap((t) => [
    ...(t.annotations ?? []),
    ...(results[0]?.annotations ?? [])
  ])
  const num = (type: string): number | null => {
    const v = Number(annotations.find((a) => a.type === type)?.description)
    return Number.isFinite(v) ? v : null
  }
  return {
    name,
    pass,
    durationMs: num('duration-ms') ?? results.reduce((n, r) => n + (r?.duration ?? 0), 0),
    steps: num('steps')
  }
}

async function runFlows(
  config: ImproveConfig,
  cwd: string,
  dir: string,
  deps: MeasureDeps
): Promise<FlowObservation[]> {
  const flows: FlowObservation[] = []
  for (const flow of config.flows) {
    if (!flow.spec) continue
    const root = playwrightRoot(cwd, flow.spec)
    const spec = path.relative(root, path.resolve(cwd, flow.spec)).replace(/\\/g, '/')
    const report = path.join(dir, `.flow-${pageSlug(flow.name)}.json`)
    fs.mkdirSync(dir, { recursive: true })
    fs.rmSync(report, { force: true })
    await deps.shell.run(`pnpm exec playwright test ${spec} --reporter=json`, root, {
      PLAYWRIGHT_JSON_OUTPUT_FILE: report,
      PLAYWRIGHT_JSON_OUTPUT_NAME: report
    })
    let json: unknown = null
    try {
      json = JSON.parse(fs.readFileSync(report, 'utf8'))
    } catch {
      // No report means the run never got as far as executing the spec.
    }
    fs.rmSync(report, { force: true })
    flows.push(parsePlaywrightReport(flow.name, json))
  }
  return flows
}

/** Delete day folders and scorecards older than RETENTION_DAYS. */
export function pruneImproveArtifacts(dir: string, date: string): string[] {
  const cutoff = new Date(Date.parse(`${date}T00:00:00Z`) - RETENTION_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10)
  const pruned: string[] = []
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return pruned
  }
  for (const name of names) {
    const m = /^(\d{4}-\d{2}-\d{2})(\.json)?$/.exec(name)
    if (m && m[1] < cutoff) {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true })
      pruned.push(name)
    }
  }
  return pruned
}

export async function runImproveMeasure(
  req: MeasureRequest,
  deps: MeasureDeps
): Promise<MeasureResult> {
  const config = loadImproveConfig(req.cwd)
  if (!config) return { status: 'off', reason: 'no .choda/improve.json' }
  if (config.mode === 'off') return { status: 'off', reason: 'mode is off' }

  const dir = improveArtifactsDir(req.artifactsDir, req.ws)
  const commit = await deps.shell.run('git rev-parse HEAD', req.cwd)
  // Tests run BEFORE the app starts: they do not need it, and a dev server
  // booting alongside a test suite made timing-sensitive tests fail on the
  // first real run (2 of 827 in the companion, all green on their own).
  const tests = config.testCmd
    ? parseVitestSummary((await deps.shell.run(config.testCmd, req.cwd)).output)
    : null
  const app = await ensureApp(config, req.cwd, deps)
  let scorecard: Scorecard
  try {
    const pages = await capturePages(config, dir, req.date, deps)
    const flows = await runFlows(config, req.cwd, dir, deps)
    scorecard = buildScorecard({
      ws: req.ws,
      date: req.date,
      generatedAt: deps.now().toISOString(),
      commit: commit.code === 0 ? commit.output.trim() || null : null,
      config,
      tests,
      pages,
      flows
    })
  } finally {
    await app?.stop()
  }

  const file = path.join(dir, `${req.date}.json`)
  fs.writeFileSync(file, JSON.stringify(scorecard, null, 2) + '\n')
  pruneImproveArtifacts(dir, req.date)
  return { status: 'written', file, scorecard, startedApp: app !== null }
}
