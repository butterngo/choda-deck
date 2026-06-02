import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import { SqliteTaskService } from '../../../../core/domain/sqlite-task-service'
import { resolveDataPaths } from '../../../../core/paths'
import { buildFeatureProjection } from '../feature-projection-builder'
import {
  assertNoNumberOfDays,
  assertNoSymbolBleed,
  assertNoDeploymentDate,
  type CeoView,
  type DevView,
  type TesterView,
  type FeatureProjectionBundle
} from '../../../../core/domain/services/feature-projection'

// ADR-NNN Pillar 5 (TASK-994) — B4 replay on LIVE pim data. This is the smoke
// replay the AC requires ("score the same or better than the manual B4 run").
// It reuses the real SqliteTaskService + builder + guards (no logic drift), and
// SELF-SKIPS when the live DB / pilot feature is absent (CI, fresh checkouts),
// so it never fabricates a DB or fails on a machine without the pilot data.
// Run it where the pilot data lives: `pnpm test` (or target this file).

const FEATURE_ID = 'feature-crawler-list-ui-enhancements'

type Verdict = 'yes' | 'partial' | 'no'
const RANK: Record<Verdict, number> = { no: 0, partial: 1, yes: 2 }

// B4 manual baseline (PILOT-B4-REPLAY.md §Measurements, M1 table). Replay must
// be element-wise >= this (never downgrade a yes).
const B4_BASELINE: Record<string, Verdict> = {
  Q1: 'yes',
  Q2: 'partial',
  Q3: 'yes',
  Q4: 'yes',
  Q5: 'yes',
  Q6: 'yes',
  Q7: 'yes'
}

function ceoStrings(b: FeatureProjectionBundle): Array<string | null> {
  const v = b.view as CeoView
  return [v.description, v.effortBand, v.status, ...v.blockers.map((x) => x.title)]
}

function scoreQuestions(ceo: FeatureProjectionBundle, dev: FeatureProjectionBundle): Record<string, Verdict> {
  const c = ceo.view as CeoView
  const d = dev.view as DevView
  const relations = new Set(d.codeRefs.map((r) => r.relation))
  return {
    Q1: c.description ? 'yes' : 'no',
    Q2: c.apps.length > 0 ? 'partial' : 'no', // teams never in graph → partial by design
    Q3: c.effortBand ? 'yes' : 'no',
    Q4: c.blockers.length > 0 ? 'yes' : 'no',
    Q5: dev.recall.length > 0 ? 'yes' : 'no',
    Q6: relations.has('modifies') && relations.has('reference') ? 'yes' : 'no',
    Q7: d.relevantDecisions.length > 0 ? 'yes' : 'no'
  }
}

describe('B4 replay on live pim data (self-skips when absent)', () => {
  let svc: SqliteTaskService | null = null
  let live = false

  beforeAll(async () => {
    const { dbPath } = resolveDataPaths()
    if (!fs.existsSync(dbPath)) return // CI / fresh checkout — do not create a DB
    svc = new SqliteTaskService(dbPath)
    const entry = await svc.getKnowledge(FEATURE_ID)
    live = !!entry && entry.frontmatter.type === 'feature'
  })

  afterAll(async () => {
    if (svc) await svc.close()
  })

  it('scores >= the manual B4 run, M1>=6, M2>=1, M3=0/0, M4 no number-of-days', async () => {
    if (!live || !svc) {
      console.warn('[replay] live pim feature not present — skipping B4 replay')
      return
    }

    // M3 + build: throwing here IS a role-bleed failure (guards live in projectFeature).
    const ceo = await buildFeatureProjection(svc, FEATURE_ID, 'ceo-po')
    const dev = await buildFeatureProjection(svc, FEATURE_ID, 'dev')

    const scores = scoreQuestions(ceo, dev)
    const yesCount = Object.values(scores).filter((v) => v === 'yes').length

    // Scorecard for the human running the smoke.
    console.log('\n=== B4 replay scorecard (live pim) ===')
    for (const q of Object.keys(B4_BASELINE)) {
      console.log(`  ${q}: ${scores[q]}  (B4 baseline: ${B4_BASELINE[q]})`)
    }
    console.log(`  M1 self-serve: ${yesCount}/7 yes`)
    console.log(`  M2 recall fire-rate (dev): ${dev.recall.length} gotcha(s)`)
    const ceoV = ceo.view as CeoView
    const devV = dev.view as DevView
    console.log(`  M3 role bleed: CEO code_refs=${'codeRefs' in ceoV ? 'LEAK' : 0}, dev code_refs=${devV.codeRefs.length}`)
    console.log(`  M4 effort band (CEO): ${ceoV.effortBand}`)
    console.log(`  honesty.lacked (ceo): ${ceo.honesty.lacked.join(', ')}`)

    // M1: >= 6 yes (AC), and element-wise non-regression vs B4.
    expect(yesCount).toBeGreaterThanOrEqual(6)
    for (const q of Object.keys(B4_BASELINE)) {
      expect(RANK[scores[q]]).toBeGreaterThanOrEqual(RANK[B4_BASELINE[q]])
    }

    // M2: at least one gotcha surfaced before the dev's first question.
    expect(dev.recall.length).toBeGreaterThanOrEqual(1)

    // M3: CEO view exposes no code_refs field at all; dev view carries them.
    expect('codeRefs' in ceoV).toBe(false)
    expect(devV.codeRefs.length).toBeGreaterThanOrEqual(1)

    // M4: no number-of-days anywhere in the CEO-visible strings.
    expect(() => assertNoNumberOfDays('replay-ceo', ...ceoStrings(ceo))).not.toThrow()
  })

  // TASK-995 AC #4 — tester role replay on the same live feature.
  it('tester: AC from all 7 realized tasks, seller edge case, Source column in regression scope', async () => {
    if (!live || !svc) {
      console.warn('[replay] live pim feature not present — skipping tester replay')
      return
    }

    const tester = await buildFeatureProjection(svc, FEATURE_ID, 'tester')
    const view = tester.view as TesterView
    const acTaskIds = view.acceptanceCriteria.map((t) => t.taskId)

    console.log('\n=== tester replay scorecard (live pim) ===')
    console.log(`  AC tasks collated: ${acTaskIds.join(', ')}`)
    console.log(`  edge cases: ${view.edgeCases.length}`)
    console.log(`  regression scope: ${view.regressionScope.join(' | ')}`)

    // AC from all 7 realized tasks of the pilot feature.
    for (const id of ['909', '910', '914', '915', '916', '917', '918']) {
      expect(acTaskIds).toContain(`TASK-${id}`)
    }

    // Edge case derived from the seller-name gotcha (trigger/context).
    expect(view.edgeCases.length).toBeGreaterThanOrEqual(1)
    expect(view.edgeCases.some((e) => /seller/i.test(e))).toBe(true)

    // Regression scope includes the shipped FE Source column (TASK-917).
    expect(view.regressionScope.some((t) => /source/i.test(t))).toBe(true)

    // M3: no dotted symbols / deployment dates in the DERIVED surfaces (edge
    // cases, regression scope, task titles). Verbatim AC items are source
    // material and are intentionally not guarded — see projectFeature tester.
    const derived = [
      ...view.edgeCases,
      ...view.regressionScope,
      ...view.acceptanceCriteria.map((t) => t.title)
    ]
    expect(() => assertNoSymbolBleed('replay-tester', ...derived)).not.toThrow()
    expect(() => assertNoDeploymentDate('replay-tester', ...derived)).not.toThrow()
  })
})
