import { describe, it, expect } from 'vitest'
import {
  assertNoNumberOfDays,
  assertNoCodeBleed,
  assertHasCodeRefs,
  assertNoSymbolBleed,
  assertNoDeploymentDate,
  deriveEffortBand,
  projectFeature,
  RoleBleedError,
  type CeoView,
  type DevView,
  type EffortTaskSignal,
  type TesterView,
  type FeatureProjectionInput
} from '../feature-projection'

function makeInput(overrides: Partial<FeatureProjectionInput> = {}): FeatureProjectionInput {
  return {
    featureId: 'feature-x',
    title: 'Feature X',
    status: 'blocked',
    effortBand: 'L',
    sections: {
      description: 'End-user feature: a list page gets a Store column and a filter dropdown.',
      'currently blocking': 'Waiting on upstream capture work.'
    },
    workspaces: ['app-api', 'app-portal'],
    realizesTaskIds: ['TASK-100', 'TASK-101'],
    effortSignal: [],
    gotchas: [
      { slug: 'gotcha-a', title: 'seller name not captured', trigger: 't', resolution: 'r' }
    ],
    codeRefs: [
      {
        taskId: 'TASK-100',
        slug: 'coderef-entity',
        path: 'Domain/Product.cs',
        symbol: 'Ichiba.Pim.Domain.Product',
        relation: 'modifies'
      }
    ],
    realizesTasksHaveTouches: true,
    realizesTasks: [
      { taskId: 'TASK-100', title: 'Add Store column to list', status: 'DONE', acItems: ['Column renders for every row'] },
      { taskId: 'TASK-101', title: 'Add store filter dropdown', status: 'TODO', acItems: ['Filter narrows the list'] }
    ],
    isStale: false,
    ...overrides
  }
}

describe('assertNoNumberOfDays (M4)', () => {
  it('passes on the band letter L', () => {
    expect(() => assertNoNumberOfDays('ceo', 'L')).not.toThrow()
  })

  it('passes on task IDs like TASK-914', () => {
    expect(() => assertNoNumberOfDays('ceo', 'Tasks: TASK-914, TASK-916')).not.toThrow()
  })

  it('passes on qualitative multi-week with no digit', () => {
    expect(() => assertNoNumberOfDays('ceo', 'wall-clock is multi-week, not single-day')).not.toThrow()
  })

  it('catches a range like ~5–7h (en-dash)', () => {
    expect(() => assertNoNumberOfDays('ceo', 'survey grew it to ~5–7h combined')).toThrow(
      RoleBleedError
    )
  })

  it('catches a plain hour estimate ~3h', () => {
    expect(() => assertNoNumberOfDays('ceo', 'original BE estimate was ~3h')).toThrow(RoleBleedError)
  })

  it('catches days', () => {
    expect(() => assertNoNumberOfDays('ceo', 'about 3 days of work')).toThrow(RoleBleedError)
  })
})

describe('assertNoCodeBleed (M3 CEO)', () => {
  it('passes on clean business prose', () => {
    expect(() =>
      assertNoCodeBleed('ceo', 'Two apps get a new Store column and a filter dropdown.')
    ).not.toThrow()
  })

  it('catches a .cs file path', () => {
    expect(() => assertNoCodeBleed('ceo', 'edit Domain/Product.cs')).toThrow(RoleBleedError)
  })

  it('catches a dotted Namespace.Class.Method symbol', () => {
    expect(() => assertNoCodeBleed('ceo', 'see Ichiba.Pim.Domain.Product')).toThrow(RoleBleedError)
  })

  it('catches SQL', () => {
    expect(() => assertNoCodeBleed('ceo', 'SELECT * FROM products')).toThrow(RoleBleedError)
  })

  it('does not flag app IDs or task numbers', () => {
    expect(() =>
      assertNoCodeBleed('ceo', 'pim-trading-api and remote-pim-portal (909+910+914)')
    ).not.toThrow()
  })
})

describe('assertHasCodeRefs (M3 dev)', () => {
  it('throws when refs expected but absent', () => {
    const view: DevView = {
      module: null,
      codeRefs: [],
      gotchas: [],
      relevantDecisions: [],
      breakingChangeNote: null
    }
    expect(() => assertHasCodeRefs('dev', view, true)).toThrow(RoleBleedError)
  })

  it('passes when no refs expected', () => {
    const view: DevView = {
      module: null,
      codeRefs: [],
      gotchas: [],
      relevantDecisions: [],
      breakingChangeNote: null
    }
    expect(() => assertHasCodeRefs('dev', view, false)).not.toThrow()
  })
})

describe('projectFeature CEO', () => {
  it('produces a clean CEO view with band letter and no symbol bleed', () => {
    const bundle = projectFeature(makeInput(), 'ceo-po')
    const view = bundle.view as { effortBand: string; apps: string[]; teams: null }
    expect(view.effortBand).toBe('L')
    expect(view.apps).toEqual(['app-api', 'app-portal'])
    expect(view.teams).toBeNull()
    expect(bundle.recall.length).toBe(1)
    expect(bundle.honesty.lacked).toContain('team-boundaries')
  })

  it('blockers carry only slug + title, never gotcha bodies', () => {
    const bundle = projectFeature(makeInput(), 'ceo-po')
    const view = bundle.view as { blockers: Array<Record<string, unknown>> }
    expect(view.blockers[0]).toEqual({ slug: 'gotcha-a', title: 'seller name not captured' })
  })

  it('throws if a gotcha title smuggles a symbol path into the CEO view', () => {
    const input = makeInput({
      gotchas: [{ slug: 'g', title: 'breaks Domain/Product.cs handling' }]
    })
    expect(() => projectFeature(input, 'ceo-po')).toThrow(RoleBleedError)
  })

  it('reports lacked effort-band when none set', () => {
    const bundle = projectFeature(makeInput({ effortBand: undefined }), 'ceo-po')
    expect(bundle.honesty.lacked).toContain('effort-band')
  })
})

describe('projectFeature dev', () => {
  it('produces a dev view carrying code_refs with relation', () => {
    const bundle = projectFeature(makeInput(), 'dev')
    const view = bundle.view as DevView
    expect(view.codeRefs).toHaveLength(1)
    expect(view.codeRefs[0].relation).toBe('modifies')
    expect(view.codeRefs[0].symbol).toBe('Ichiba.Pim.Domain.Product')
    expect(bundle.recall.length).toBe(1)
  })

  it('throws role bleed when REALIZES tasks touch code but refs are empty', () => {
    const input = makeInput({ codeRefs: [], realizesTasksHaveTouches: true })
    expect(() => projectFeature(input, 'dev')).toThrow(RoleBleedError)
  })

  it('does not throw when no tasks touch code', () => {
    const input = makeInput({ codeRefs: [], realizesTasksHaveTouches: false })
    expect(() => projectFeature(input, 'dev')).not.toThrow()
  })

  it('flags stale refs in honesty', () => {
    const bundle = projectFeature(makeInput({ isStale: true }), 'dev')
    expect(bundle.honesty.lacked).toContain('stale-refs')
  })
})

describe('assertNoSymbolBleed (M3 tester)', () => {
  it('passes on a file path (tester needs to know which area to exercise)', () => {
    expect(() => assertNoSymbolBleed('tester', 'verify the Source column in list-page.tsx')).not.toThrow()
  })

  it('catches a dotted Namespace.Class.Method symbol', () => {
    expect(() => assertNoSymbolBleed('tester', 'calls Ichiba.Pim.Domain.Product')).toThrow(RoleBleedError)
  })
})

describe('assertNoDeploymentDate (M3 tester)', () => {
  it('passes on a task ID', () => {
    expect(() => assertNoDeploymentDate('tester', 'shipped in TASK-917')).not.toThrow()
  })

  it('catches an ISO date', () => {
    expect(() => assertNoDeploymentDate('tester', 'deployed 2026-05-13 to qc')).toThrow(RoleBleedError)
  })

  it('catches an ISO datetime', () => {
    expect(() => assertNoDeploymentDate('tester', 'released 2026-05-13T09:18')).toThrow(RoleBleedError)
  })
})

describe('projectFeature tester', () => {
  it('collates AC from each realized task, attributed', () => {
    const bundle = projectFeature(makeInput(), 'tester')
    const view = bundle.view as TesterView
    expect(view.acceptanceCriteria).toHaveLength(2)
    expect(view.acceptanceCriteria.map((t) => t.taskId)).toEqual(['TASK-100', 'TASK-101'])
    expect(view.acceptanceCriteria[0].acItems).toEqual(['Column renders for every row'])
  })

  it('derives edge cases from gotcha trigger + context', () => {
    const input = makeInput({
      gotchas: [
        {
          slug: 'gotcha-seller-name-not-captured',
          title: 'seller name not captured',
          trigger: 'crawler fills seller_name for only 26% of rows',
          context: 'verify both empty and populated rows'
        }
      ]
    })
    const view = projectFeature(input, 'tester').view as TesterView
    expect(view.edgeCases).toHaveLength(1)
    expect(view.edgeCases[0]).toContain('seller name not captured')
    expect(view.edgeCases[0]).toContain('26%')
    expect(view.edgeCases[0]).toContain('both empty and populated rows')
  })

  it('still yields an edge-case line when a gotcha has no trigger/context', () => {
    const input = makeInput({ gotchas: [{ slug: 'g', title: 'bare gotcha' }] })
    const view = projectFeature(input, 'tester').view as TesterView
    expect(view.edgeCases).toEqual(['bare gotcha'])
  })

  it('regression scope = only shipped (DONE) realized tasks', () => {
    const view = projectFeature(makeInput(), 'tester').view as TesterView
    expect(view.regressionScope).toEqual(['Add Store column to list'])
  })

  it('relays a dotted symbol verbatim inside an AC item (source material, not bleed)', () => {
    const input = makeInput({
      realizesTasks: [
        { taskId: 'TASK-1', title: 'clean title', status: 'DONE', acItems: ['calls Ichiba.Pim.Domain.Product'] }
      ]
    })
    const view = projectFeature(input, 'tester').view as TesterView
    expect(view.acceptanceCriteria[0].acItems[0]).toContain('Ichiba.Pim.Domain.Product')
  })

  it('throws symbol bleed when a realized TASK TITLE carries a dotted symbol', () => {
    const input = makeInput({
      realizesTasks: [
        { taskId: 'TASK-1', title: 'refactor Ichiba.Pim.Domain.Product', status: 'DONE', acItems: [] }
      ]
    })
    expect(() => projectFeature(input, 'tester')).toThrow(RoleBleedError)
  })

  it('throws deployment-date bleed when an edge case carries an ISO date', () => {
    const input = makeInput({
      gotchas: [{ slug: 'g', title: 'g', trigger: 'regressed after 2026-05-13 deploy' }]
    })
    expect(() => projectFeature(input, 'tester')).toThrow(RoleBleedError)
  })

  it('reports honesty used/lacked for the tester slices', () => {
    const bundle = projectFeature(makeInput(), 'tester')
    expect(bundle.honesty.used).toEqual(
      expect.arrayContaining(['acceptance-criteria', 'edge-cases', 'regression-scope'])
    )
  })

  it('lacks regression-scope when no realized task is DONE', () => {
    const input = makeInput({
      realizesTasks: [{ taskId: 'TASK-1', title: 't', status: 'TODO', acItems: [] }]
    })
    const bundle = projectFeature(input, 'tester')
    expect(bundle.honesty.lacked).toContain('regression-scope')
    expect((bundle.view as TesterView).regressionScope).toEqual([])
  })
})

// TASK-1025 — read-time effort-band derivation (close the PILOT-2 band gap).
function sig(overrides: Partial<EffortTaskSignal> = {}): EffortTaskSignal {
  return { taskId: 'TASK-0', labels: [], acItemCount: 0, blockedByCount: 0, ...overrides }
}

describe('deriveEffortBand (TASK-1025)', () => {
  it('returns null on zero evidence (fails safe, never fabricates)', () => {
    expect(deriveEffortBand([])).toBeNull()
  })

  it('maps task count to a base band: 1→S, 2-3→M, 4-6→L, 7+→XL', () => {
    expect(deriveEffortBand(Array.from({ length: 1 }, () => sig()))?.band).toBe('S')
    expect(deriveEffortBand(Array.from({ length: 2 }, () => sig()))?.band).toBe('M')
    expect(deriveEffortBand(Array.from({ length: 4 }, () => sig()))?.band).toBe('L')
    expect(deriveEffortBand(Array.from({ length: 8 }, () => sig()))?.band).toBe('XL')
  })

  it('bumps one band when any realized task is an epic', () => {
    const base = Array.from({ length: 2 }, () => sig()) // base M
    base[0] = sig({ labels: ['epic'] })
    const out = deriveEffortBand(base)
    expect(out?.band).toBe('L')
    expect(out?.reasoning).toContain('+1 epic task')
  })

  it('bumps one band on a heavy spec surface (>=15 AC items total)', () => {
    const out = deriveEffortBand([sig({ acItemCount: 9 }), sig({ acItemCount: 6 })]) // base M, +1
    expect(out?.band).toBe('L')
    expect(out?.reasoning).toContain('15 AC items')
  })

  it('bumps one band when work is blocked (max blockedBy >= 2)', () => {
    const out = deriveEffortBand([sig({ blockedByCount: 2 }), sig()]) // base M, +1
    expect(out?.band).toBe('L')
    expect(out?.reasoning).toContain('2 blockers')
  })

  it('clamps at XL when modifiers stack past the top band', () => {
    const tasks = Array.from({ length: 8 }, () => sig({ labels: ['epic'], blockedByCount: 3 }))
    expect(deriveEffortBand(tasks)?.band).toBe('XL') // base XL + 2 bumps, clamped
  })

  it('reasoning carries counts only — passes assertNoNumberOfDays (M4)', () => {
    const out = deriveEffortBand(
      Array.from({ length: 8 }, () => sig({ labels: ['epic'], acItemCount: 3, blockedByCount: 2 }))
    )
    expect(out).not.toBeNull()
    expect(() => assertNoNumberOfDays('derived', out!.reasoning)).not.toThrow()
  })
})

describe('projectFeature ceo-po — band source (TASK-1025)', () => {
  it('authored band wins over derivation (human override, AC #3)', () => {
    const view = projectFeature(makeInput({ effortBand: 'S', effortSignal: [sig(), sig(), sig(), sig()] }), 'ceo-po')
      .view as CeoView
    expect(view.effortBand).toBe('S')
    expect(view.effortBandSource).toBe('authored')
    expect(view.effortBandReasoning).toBeNull()
  })

  it('derives a band with reasoning when none is authored', () => {
    const bundle = projectFeature(
      makeInput({ effortBand: undefined, effortSignal: [sig(), sig(), sig(), sig()] }),
      'ceo-po'
    )
    const view = bundle.view as CeoView
    expect(view.effortBand).toBe('L')
    expect(view.effortBandSource).toBe('derived')
    expect(view.effortBandReasoning).toContain('4 realized tasks')
    expect(bundle.honesty.used).toContain('effort-band (derived)')
  })

  it('honesty distinguishes authored vs derived vs lacked (AC #4)', () => {
    const authored = projectFeature(makeInput({ effortBand: 'M', effortSignal: [] }), 'ceo-po')
    expect(authored.honesty.used).toContain('effort-band (authored)')

    const lacked = projectFeature(makeInput({ effortBand: undefined, effortSignal: [] }), 'ceo-po')
    expect(lacked.honesty.lacked).toContain('effort-band')
    expect((lacked.view as CeoView).effortBand).toBeNull()
    expect((lacked.view as CeoView).effortBandSource).toBeNull()
  })
})
