import { describe, it, expect } from 'vitest'
import {
  assertNoNumberOfDays,
  assertNoCodeBleed,
  assertHasCodeRefs,
  projectFeature,
  RoleBleedError,
  type DevView,
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
