import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { png } from './__fixtures__/png'
import {
  buildScorecard,
  pageSlug,
  parseVitestSummary,
  pngDiffRatio,
  UI_CHANGED_THRESHOLD
} from './measure-engine'
import { validateImproveConfig, type ImproveConfig } from './improve-config'
import companion from './__fixtures__/companion-improve.json'

// TASK-2356 — the pure scorecard engine.

function config(): ImproveConfig {
  const r = validateImproveConfig(companion)
  if (!r.ok) throw new Error('fixture invalid')
  return r.config
}

describe('parseVitestSummary', () => {
  it('sums every vitest run in the output and ignores ANSI colour', () => {
    const out = [
      '\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[32m827 passed\u001b[39m\u001b[22m (827)',
      'noise',
      ' FAIL  src/a.test.ts > retries the upload',
      ' FAIL  src/a.test.ts > retries the upload',
      '      Tests  2 failed | 146 passed (148)'
    ].join('\n')
    expect(parseVitestSummary(out)).toEqual({
      total: 975,
      passed: 973,
      failed: 2,
      passRate: 0.998,
      failures: ['src/a.test.ts > retries the upload']
    })
  })

  it('returns null when no summary line exists', () => {
    expect(parseVitestSummary('ERR_PNPM_NO_SCRIPT')).toBeNull()
  })
})

describe('pngDiffRatio', () => {
  it('is 0 for identical images and counts changed pixels otherwise', () => {
    expect(pngDiffRatio(png(100, 100), png(100, 100))).toBe(0)
    expect(pngDiffRatio(png(100, 100), png(100, 100, 50))).toBe(0.005)
    expect(pngDiffRatio(png(100, 100), png(100, 100, 200))).toBe(0.02)
  })

  it('crosses the 1% threshold only when more than 1% of pixels change', () => {
    expect(pngDiffRatio(png(100, 100), png(100, 100, 50)) > UI_CHANGED_THRESHOLD).toBe(false)
    expect(pngDiffRatio(png(100, 100), png(100, 100, 200)) > UI_CHANGED_THRESHOLD).toBe(true)
  })

  it('treats a size change as a full change', () => {
    expect(pngDiffRatio(png(100, 100), png(100, 120))).toBe(1)
  })
})

describe('pageSlug', () => {
  it('turns hash routes into stable file names', () => {
    expect(pageSlug('/#/projects')).toBe('projects')
    expect(pageSlug('/#/workspaces/main?tab=improve')).toBe('workspaces-main-tab-improve')
    expect(pageSlug('/')).toBe('root')
  })
})

describe('buildScorecard', () => {
  it('fills auto criteria from observations and leaves agent criteria null', () => {
    const s = buildScorecard({
      ws: 'web',
      date: '2026-10-10',
      generatedAt: 'x',
      commit: 'abc',
      config: config(),
      tests: { total: 10, passed: 9, failed: 1, passRate: 0.9, failures: [] },
      pages: [
        {
          path: '/#/projects',
          screenshot: '2026-10-10/projects.png',
          lcpMs: 812,
          consoleErrors: 2,
          uiChanged: true,
          diffRatio: null
        }
      ],
      flows: [{ name: 'search-to-task', pass: true, durationMs: 985, steps: 4 }]
    })
    expect(s.criteria.map((c) => c.value)).toEqual([0.9, 812, 2, null, true])
  })
})

describe('no model, no claude (AC)', () => {
  it('no improve module imports an AI client or spawns claude', () => {
    const files = [
      ...fs
        .readdirSync(__dirname)
        .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
        .map((f) => path.join(__dirname, f)),
      path.join(__dirname, '../../../adapters/cli/improve-command.ts')
    ]
    expect(files.length).toBeGreaterThanOrEqual(4)
    const forbidden = /azure-review|ac-review|@anthropic-ai|openai|['"`]claude['"`]|claude -p/
    for (const f of files) {
      expect(fs.readFileSync(f, 'utf8'), path.basename(f)).not.toMatch(forbidden)
    }
  })
})
