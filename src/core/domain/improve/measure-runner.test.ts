import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { saveImproveConfig } from './improve-config'
import {
  improveArtifactsDir,
  parsePlaywrightReport,
  playwrightRoot,
  pruneImproveArtifacts,
  runImproveMeasure,
  type MeasureDeps
} from './measure-runner'
import { png } from './__fixtures__/png'
import companion from './__fixtures__/companion-improve.json'

// TASK-2356 — the runner with a fake browser and a fake shell: no Chromium, no
// dev server, no test run. What it proves is the orchestration and the files.

let tmp: string
let cwd: string
let artifactsDir: string
let appUp: boolean
let started: string[]
let stopped: number
let changedPixels: Record<string, number>
let lcp: number

function deps(): MeasureDeps {
  let clock = Date.parse('2026-10-10T03:00:00Z')
  return {
    openDriver: async () => ({
      capture: async (url: string) => ({
        png: png(64, 64, changedPixels[url] ?? 0),
        lcpMs: lcp,
        consoleErrors: url.endsWith('projects') ? 1 : 0
      }),
      close: async () => {}
    }),
    shell: {
      run: async (cmd: string, _cwd: string, env?: Record<string, string>) => {
        if (cmd.startsWith('git')) return { code: 0, output: 'abc123\n' }
        if (cmd.includes('playwright test')) {
          fs.writeFileSync(
            env!.PLAYWRIGHT_JSON_OUTPUT_FILE,
            JSON.stringify({
              suites: [
                {
                  specs: [
                    {
                      tests: [
                        {
                          annotations: [
                            { type: 'duration-ms', description: '900' },
                            { type: 'steps', description: '4' }
                          ],
                          results: [{ status: 'passed', duration: 950 }]
                        }
                      ]
                    }
                  ]
                }
              ]
            })
          )
          return { code: 0, output: '' }
        }
        return { code: 0, output: '      Tests  9 passed | 1 failed (10)' }
      },
      start: (cmd: string) => {
        started.push(cmd)
        appUp = true
        return { stop: async () => void stopped++ }
      }
    },
    reachable: async () => appUp,
    sleep: async () => {},
    now: () => new Date((clock += 1000))
  }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'improve-measure-'))
  cwd = path.join(tmp, 'repo')
  fs.mkdirSync(path.join(cwd, 'packages', 'web', 'e2e'), { recursive: true })
  fs.writeFileSync(path.join(cwd, 'packages', 'web', 'playwright.config.ts'), '')
  artifactsDir = path.join(tmp, 'artifacts')
  appUp = true
  started = []
  stopped = 0
  changedPixels = {}
  lcp = 800
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

const req = (date = '2026-10-10') => ({ ws: 'web', cwd, artifactsDir, date })
const dir = () => improveArtifactsDir(artifactsDir, 'web')

describe('runImproveMeasure — off', () => {
  it('no config → exit without writing anything', async () => {
    expect(await runImproveMeasure(req(), deps())).toMatchObject({ status: 'off' })
    expect(fs.existsSync(dir())).toBe(false)
  })

  it('mode off → exit without writing anything', async () => {
    saveImproveConfig(cwd, { ...companion, mode: 'off' })
    expect(await runImproveMeasure(req(), deps())).toMatchObject({ status: 'off' })
    expect(fs.existsSync(dir())).toBe(false)
  })
})

describe('runImproveMeasure — measuring', () => {
  beforeEach(() => {
    saveImproveConfig(cwd, companion)
  })

  it('writes a scorecard with tests, pages, flows and the auto criteria', async () => {
    const r = await runImproveMeasure(req(), deps())
    expect(r.status).toBe('written')
    if (r.status !== 'written') return
    const s = JSON.parse(fs.readFileSync(r.file, 'utf8'))
    expect(s.tests).toEqual({ total: 10, passed: 9, failed: 1, passRate: 0.9, failures: [] })
    expect(s.commit).toBe('abc123')
    expect(s.pages.map((p: { screenshot: string }) => p.screenshot)).toEqual([
      '2026-10-10/sync.png',
      '2026-10-10/projects.png',
      '2026-10-10/activity.png'
    ])
    for (const p of s.pages) expect(fs.existsSync(path.join(dir(), p.screenshot))).toBe(true)
    expect(s.flows).toEqual([{ name: 'search-to-task', pass: true, durationMs: 900, steps: 4 }])
    expect(s.criteria.map((c: { value: unknown }) => c.value)).toEqual([0.9, 800, 1, null, true])
  })

  it('a second run on unchanged UI: same deterministic fields, uiChanged false', async () => {
    const first = await runImproveMeasure(req(), deps())
    lcp = 870
    const second = await runImproveMeasure(req(), deps())
    if (first.status !== 'written' || second.status !== 'written') throw new Error('not written')
    const a = first.scorecard
    const b = second.scorecard
    expect(a.pages.every((p) => p.uiChanged)).toBe(true) // nothing to compare against yet
    expect(b.pages.every((p) => !p.uiChanged)).toBe(true)
    expect(b.tests).toEqual(a.tests)
    expect(b.flows.map((f) => f.pass)).toEqual(a.flows.map((f) => f.pass))
    expect(b.pages.map((p) => [p.screenshot, p.consoleErrors])).toEqual(
      a.pages.map((p) => [p.screenshot, p.consoleErrors])
    )
  })

  it('a page whose pixels changed by more than 1% is flagged, the others are not', async () => {
    await runImproveMeasure(req('2026-10-09'), deps())
    changedPixels['http://localhost:5173/#/projects'] = 64 * 64 * 0.05
    const r = await runImproveMeasure(req(), deps())
    if (r.status !== 'written') throw new Error('not written')
    expect(r.scorecard.pages.map((p) => [p.path, p.uiChanged])).toEqual([
      ['/#/sync', false],
      ['/#/projects', true],
      ['/#/activity', false]
    ])
  })

  it('starts the app when it is down and stops it afterwards; leaves a running app alone', async () => {
    appUp = false
    const r = await runImproveMeasure(req(), deps())
    expect(started).toEqual(['pnpm dev'])
    expect(stopped).toBe(1)
    expect(r).toMatchObject({ startedApp: true })

    started = []
    const again = await runImproveMeasure(req(), deps())
    expect(started).toEqual([])
    expect(again).toMatchObject({ startedApp: false })
  })
})

describe('helpers', () => {
  it('finds the playwright root above a spec', () => {
    expect(playwrightRoot(cwd, 'packages/web/e2e/search-to-task.spec.ts')).toBe(
      path.join(cwd, 'packages', 'web')
    )
  })

  it('a report with a failed result is a failed flow; no report is a failed flow', () => {
    const failed = { suites: [{ specs: [{ tests: [{ results: [{ status: 'failed' }] }] }] }] }
    expect(parsePlaywrightReport('f', failed).pass).toBe(false)
    expect(parsePlaywrightReport('f', null)).toEqual({
      name: 'f',
      pass: false,
      durationMs: null,
      steps: null
    })
  })

  it('prunes day folders and scorecards older than 90 days', () => {
    fs.mkdirSync(path.join(dir(), '2026-06-01'), { recursive: true })
    fs.writeFileSync(path.join(dir(), '2026-06-01.json'), '{}')
    fs.mkdirSync(path.join(dir(), '2026-10-01'), { recursive: true })
    expect(pruneImproveArtifacts(dir(), '2026-10-10').sort()).toEqual([
      '2026-06-01',
      '2026-06-01.json'
    ])
    expect(fs.readdirSync(dir())).toEqual(['2026-10-01'])
  })
})
