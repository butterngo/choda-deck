import * as fs from 'fs'
import { spawn } from 'child_process'
import type {
  CommandResult,
  MeasureDeps,
  PageCapture,
  PageDriver,
  StartedProcess
} from '../../core/domain/improve/measure-runner'

// TASK-2356 — `choda-deck improve measure <workspace>`. Thin adapter: resolve the
// workspace's cwd from the DB, then hand the core runner a real browser
// (Playwright, headless Chromium) and a real shell. Measuring is deterministic and
// spends no tokens: this module calls no model and never launches the Claude CLI.

export const IMPROVE_HELP = `improve measure <workspace>
  Measure a workspace's improve loop scorecard (TASK-2352) from <cwd>/.choda/improve.json:
  test pass rate, per-page screenshot / LCP / console errors, e2e flows, and whether
  each page changed since the last run. Writes <data>/artifacts/improve/<ws>/<date>.json.
  Exits 0 without writing when the workspace has no config or its mode is off.
`

const VIEWPORT = { width: 1280, height: 800 }
const LCP_SETTLE_MS = 1500
/**
 * LCP samples per page, after one discarded warm-up load. A single load was too
 * noisy to compare day to day: two back-to-back runs on the same commit moved a
 * 160 ms page to 248 ms, and the first page also paid the dev server's cold
 * compile. The median of five warm loads is what gets recorded.
 */
const LCP_SAMPLES = 5

interface Load {
  lcpMs: number | null
  consoleErrors: number
  png: Buffer | null
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/** Headless Chromium via Playwright; every load is a fresh page so each has its own LCP. */
async function openPlaywrightDriver(): Promise<PageDriver> {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 })

  const load = async (url: string, screenshot: boolean): Promise<Load> => {
    const page = await context.newPage()
    let consoleErrors = 0
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors++
    })
    page.on('pageerror', () => consoleErrors++)
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 })
      const lcpMs = await page.evaluate(
        (settle) =>
          new Promise<number | null>((resolve) => {
            let last: number | null = null
            new PerformanceObserver((list) => {
              const entries = list.getEntries()
              last = entries[entries.length - 1]?.startTime ?? last
            }).observe({ type: 'largest-contentful-paint', buffered: true })
            setTimeout(() => resolve(last), settle)
          }),
        LCP_SETTLE_MS
      )
      const png = screenshot
        ? await page.screenshot({ animations: 'disabled', caret: 'hide' })
        : null
      return { lcpMs, consoleErrors, png }
    } finally {
      await page.close()
    }
  }

  return {
    async warmUp(urls: string[]) {
      for (const url of urls) await load(url, false)
    },
    async capture(url: string): Promise<PageCapture> {
      await load(url, false) // per-page warm-up, discarded
      const samples: Load[] = []
      for (let i = 0; i < LCP_SAMPLES; i++) samples.push(await load(url, i === LCP_SAMPLES - 1))
      const last = samples[samples.length - 1]
      return {
        png: last.png as Buffer,
        lcpMs: median(samples.flatMap((s) => (s.lcpMs === null ? [] : [s.lcpMs]))),
        consoleErrors: last.consoleErrors
      }
    },
    async close() {
      await browser.close()
    }
  }
}

const shell = {
  run(cmd: string, cwd: string, env?: Record<string, string>): Promise<CommandResult> {
    return new Promise((resolve) => {
      const child = spawn(cmd, {
        cwd,
        shell: true,
        windowsHide: true,
        env: { ...process.env, ...env, CI: '1', FORCE_COLOR: '0' }
      })
      let output = ''
      const take = (c: Buffer): void => {
        if (output.length < 4 * 1024 * 1024) output += c.toString('utf8')
      }
      child.stdout?.on('data', take)
      child.stderr?.on('data', take)
      child.on('error', (err) => resolve({ code: null, output: String(err) }))
      child.on('close', (code) => resolve({ code, output }))
    })
  },
  start(cmd: string, cwd: string): StartedProcess {
    const win = process.platform === 'win32'
    const child = spawn(cmd, {
      cwd,
      shell: true,
      windowsHide: true,
      detached: !win,
      stdio: 'ignore'
    })
    return {
      stop: () =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.pid === undefined) return resolve()
          child.once('exit', () => resolve())
          if (win) {
            // A shell-started dev server is a process TREE (cmd → pnpm → node); only
            // taskkill /T takes the whole tree down, so nothing keeps the port.
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
          } else {
            process.kill(-child.pid, 'SIGTERM')
          }
          setTimeout(resolve, 10_000)
        })
    }
  }
}

async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
    return res.status < 500
  } catch {
    return false
  }
}

export const realMeasureDeps: MeasureDeps = {
  openDriver: openPlaywrightDriver,
  shell,
  reachable,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => new Date()
}

export async function dispatchImprove(sub: string | undefined, args: string[]): Promise<number> {
  if (sub !== 'measure' || args.includes('--help') || args.includes('-h')) {
    const asked = args.includes('--help') || args.includes('-h')
    ;(asked ? process.stdout : process.stderr).write(
      asked
        ? IMPROVE_HELP
        : `error: only "improve measure <workspace>" is supported\n\n${IMPROVE_HELP}`
    )
    return asked ? 0 : 2
  }
  const ws = args[0]
  if (!ws || args.length > 1) {
    process.stderr.write(`error: improve measure takes exactly one workspace id\n\n${IMPROVE_HELP}`)
    return 2
  }

  const { resolveDataPaths } = await import('../../core/paths')
  const { runImproveMeasure } = await import('../../core/domain/improve/measure-runner')
  const { localDate, DEFAULT_TZ } = await import('../../core/domain/activity/activity-digest')
  const { default: Database } = await import('better-sqlite3')

  const { dbPath, artifactsDir } = resolveDataPaths()
  if (!fs.existsSync(dbPath)) {
    process.stderr.write(`error: no database at ${dbPath} — unknown workspace "${ws}"\n`)
    return 2
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  let cwd: string | undefined
  try {
    cwd = (db.prepare('SELECT cwd FROM workspaces WHERE id = ?').get(ws) as { cwd?: string })?.cwd
  } finally {
    db.close()
  }
  if (!cwd) {
    process.stderr.write(`error: unknown workspace "${ws}"\n`)
    return 2
  }

  const result = await runImproveMeasure(
    { ws, cwd, artifactsDir, date: localDate(Date.now(), DEFAULT_TZ) },
    realMeasureDeps
  )
  if (result.status === 'off') {
    process.stdout.write(`improve measure ${ws}: skipped (${result.reason})\n`)
    return 0
  }
  const s = result.scorecard
  const changed = s.pages.filter((p) => p.uiChanged).length
  process.stdout.write(
    `improve measure ${ws}: tests ${s.tests ? `${s.tests.passed}/${s.tests.total}` : 'n/a'} · ` +
      `${s.pages.length} pages (${changed} changed) · ${s.flows.length} flows -> ${result.file}\n`
  )
  return 0
}
