import { describe, it, expect } from 'vitest'
import {
  buildFeatureProjection,
  parseSections,
  FeatureNotFoundError,
  type FeatureProjectionDeps
} from '../feature-projection-builder'
import type { KnowledgeEntry } from '../../../../core/domain/knowledge-types'
import type { Relationship, Task } from '../../../../core/domain/task-types'
import type { CodeRefRow, TouchesEdge } from '../../../../core/domain/code-ref-types'
import type {
  CeoView,
  DevView,
  TesterView
} from '../../../../core/domain/services/feature-projection'

const FEATURE_BODY = `## Description

End-user feature: the Crawler products list gets a Store column and a filter dropdown.

## Currently blocking

Hold until upstream capture work lands and the FE owner accepts v1.
`

const GOTCHA_BODY = `## Trigger

Crawler fills seller_name for only 26% of rows.

## Context

Verify both empty and populated seller rows render correctly.

## Resolution

Hold delivery until seller name is captured.
`

function taskRow(overrides: Partial<Task> = {}): Task {
  return {
    id: 'TASK-0',
    projectId: 'pim',
    parentTaskId: null,
    title: 'task',
    status: 'TODO',
    priority: 'medium',
    labels: [],
    dueDate: null,
    pinned: false,
    filePath: null,
    body: null,
    blockedBy: [],
    createdAt: '2026-05-29',
    updatedAt: '2026-05-29',
    ...overrides
  }
}

function featureEntry(): KnowledgeEntry {
  return {
    slug: 'feature-x',
    frontmatter: {
      type: 'feature',
      title: 'Feature: Crawler list UI enhancements',
      projectId: 'pim',
      scope: 'project',
      refs: [],
      createdAt: '2026-05-29',
      lastVerifiedAt: '2026-05-29',
      structured: {
        realizesTasks: ['TASK-909', 'TASK-914'],
        inWorkspaces: ['pim-trading-api', 'remote-pim-portal'],
        effortBand: 'L',
        status: 'blocked'
      }
    },
    body: FEATURE_BODY,
    filePath: '/x/feature-x.md',
    staleness: [],
    isStale: false
  }
}

function gotchaEntry(): KnowledgeEntry {
  return {
    slug: 'gotcha-seller',
    frontmatter: {
      type: 'gotcha',
      title: 'Gotcha: seller_name not captured (26% data)',
      projectId: 'pim',
      scope: 'project',
      refs: [],
      createdAt: '2026-05-29',
      lastVerifiedAt: '2026-05-29',
      structured: { affectedFeatureId: 'feature-x' }
    },
    body: GOTCHA_BODY,
    filePath: '/x/gotcha-seller.md',
    staleness: [],
    isStale: false
  }
}

interface FakeData {
  entries: Record<string, KnowledgeEntry>
  edges: Relationship[]
  touches: Record<string, TouchesEdge[]>
  codeRefs: Record<string, CodeRefRow>
  tasks: Record<string, Task>
}

function makeDeps(data: FakeData): FeatureProjectionDeps {
  const notImpl = (): never => {
    throw new Error('not implemented in fake')
  }
  return {
    getKnowledge: async (slug: string) => data.entries[slug] ?? null,
    getRelationshipsFrom: async (id, type) =>
      data.edges.filter((e) => e.fromId === id && (!type || e.type === type)),
    getRelationshipsTo: async (id, type) =>
      data.edges.filter((e) => e.toId === id && (!type || e.type === type)),
    getTouchesForTask: async (taskId: string) => data.touches[taskId] ?? [],
    getCodeRef: async (slug: string) => data.codeRefs[slug] ?? null,
    getTask: async (id: string) => data.tasks[id] ?? null,
    // unused by the builder
    createTask: notImpl,
    updateTask: notImpl,
    deleteTask: notImpl,
    findTasks: notImpl,
    getSubtasks: notImpl,
    getPinnedTasks: notImpl,
    getDueTasks: notImpl,
    addDependency: notImpl,
    removeDependency: notImpl,
    getDependencies: notImpl,
    createKnowledge: notImpl,
    registerExistingKnowledge: notImpl,
    listKnowledge: notImpl,
    updateKnowledge: notImpl,
    verifyKnowledge: notImpl,
    deleteKnowledge: notImpl,
    searchKnowledge: notImpl,
    addRelationship: notImpl,
    removeRelationship: notImpl,
    getRelationships: notImpl,
    upsertCodeRef: notImpl,
    listCodeRefsByPrefix: notImpl,
    deleteCodeRef: notImpl,
    addTouches: notImpl,
    removeTouches: notImpl,
    getTouchesForCodeRef: notImpl
  }
}

function pilotData(): FakeData {
  return {
    entries: { 'feature-x': featureEntry(), 'gotcha-seller': gotchaEntry() },
    edges: [
      { fromId: 'feature-x', toId: 'pim-trading-api', type: 'IN' },
      { fromId: 'feature-x', toId: 'remote-pim-portal', type: 'IN' },
      { fromId: 'TASK-909', toId: 'feature-x', type: 'REALIZES' },
      { fromId: 'TASK-914', toId: 'feature-x', type: 'REALIZES' },
      { fromId: 'gotcha-seller', toId: 'feature-x', type: 'ABOUT' }
    ],
    touches: {
      'TASK-914': [
        { taskId: 'TASK-914', codeRefSlug: 'coderef-entity', relation: 'modifies' },
        { taskId: 'TASK-914', codeRefSlug: 'coderef-doc', relation: 'reference' }
      ],
      'TASK-909': []
    },
    codeRefs: {
      'coderef-entity': {
        slug: 'coderef-entity',
        projectId: 'pim',
        workspaceId: 'pim-trading-api',
        path: 'Domain/Product.cs',
        symbol: 'Ichiba.Pim.Domain.Product',
        lineHint: 95,
        commitSha: 'abc',
        createdAt: '2026-05-29',
        lastVerifiedAt: '2026-05-29'
      },
      'coderef-doc': {
        slug: 'coderef-doc',
        projectId: 'pim',
        workspaceId: 'pim-trading-api',
        path: 'docs/knowledge/crawler-service-integration.md',
        symbol: null,
        lineHint: null,
        commitSha: 'abc',
        createdAt: '2026-05-29',
        lastVerifiedAt: '2026-05-29'
      }
    },
    tasks: {
      'TASK-909': taskRow({
        id: 'TASK-909',
        title: 'BE: expose seller_name in product list response',
        status: 'DONE',
        body: '## Acceptance\n\n- [x] Response carries seller_name\n- [x] Null when not crawled\n'
      }),
      'TASK-914': taskRow({
        id: 'TASK-914',
        title: 'FE: add Source column to crawler list',
        status: 'DONE',
        body: '## Acceptance\n\n- [ ] Source column renders for every row\n'
      })
    }
  }
}

describe('parseSections', () => {
  it('splits level-2 headings into a lowercased map', () => {
    const s = parseSections(FEATURE_BODY)
    expect(Object.keys(s)).toEqual(['description', 'currently blocking'])
    expect(s['description']).toContain('Store column')
  })

  it('is CRLF-safe', () => {
    const s = parseSections('## A\r\nline one\r\n## B\r\nline two')
    expect(s['a']).toBe('line one')
    expect(s['b']).toBe('line two')
  })
})

describe('buildFeatureProjection', () => {
  it('throws when the slug is not a feature node', async () => {
    const data = pilotData()
    data.entries['feature-x'].frontmatter.type = 'gotcha'
    await expect(buildFeatureProjection(makeDeps(data), 'feature-x', 'ceo-po')).rejects.toThrow(
      FeatureNotFoundError
    )
  })

  it('CEO bundle: apps from IN, band letter, gotcha titles, no code_refs walked', async () => {
    const bundle = await buildFeatureProjection(makeDeps(pilotData()), 'feature-x', 'ceo-po')
    const view = bundle.view as CeoView
    expect(view.apps).toEqual(['pim-trading-api', 'remote-pim-portal'])
    expect(view.effortBand).toBe('L')
    expect(view.teams).toBeNull()
    // TASK-1026: blocked feature → blockers from the `## Currently blocking`
    // section (not the gotcha); the gotcha surfaces as a concern instead.
    expect(view.blockers).toHaveLength(1)
    expect(view.blockers[0].slug).toBe('currently-blocking')
    expect(view.concerns).toEqual([{ slug: 'gotcha-seller', title: 'Gotcha: seller_name not captured (26% data)' }])
    expect(bundle.recall).toHaveLength(1)
    expect(bundle.honesty.lacked).toContain('team-boundaries')
  })

  it('CEO bundle: derives a band + reasoning when none is authored (TASK-1025)', async () => {
    const data = pilotData()
    // PILOT-2 condition: no pre-authored band on the feature node.
    delete data.entries['feature-x'].frontmatter.structured!.effortBand
    const bundle = await buildFeatureProjection(makeDeps(data), 'feature-x', 'ceo-po')
    const view = bundle.view as CeoView
    // 2 realized tasks (TASK-909, TASK-914), no epic / <15 AC / no blockers → base M.
    expect(view.effortBand).toBe('M')
    expect(view.effortBandSource).toBe('derived')
    expect(view.effortBandReasoning).toContain('2 realized tasks')
    expect(bundle.honesty.used).toContain('effort-band (derived)')
  })

  it('dev bundle: code_refs resolved with relation (modifies + reference)', async () => {
    const bundle = await buildFeatureProjection(makeDeps(pilotData()), 'feature-x', 'dev')
    const view = bundle.view as DevView
    const relations = view.codeRefs.map((r) => r.relation).sort()
    expect(relations).toEqual(['modifies', 'reference'])
    const entity = view.codeRefs.find((r) => r.slug === 'coderef-entity')
    expect(entity?.path).toBe('Domain/Product.cs')
    expect(entity?.symbol).toBe('Ichiba.Pim.Domain.Product')
    expect(bundle.recall).toHaveLength(1)
    expect(bundle.honesty.used).toContain('code-refs')
  })

  it('tester bundle: AC collated per realized task, edge case from gotcha, regression = DONE tasks', async () => {
    const bundle = await buildFeatureProjection(makeDeps(pilotData()), 'feature-x', 'tester')
    const view = bundle.view as TesterView

    // AC collated from each realized task (REALIZES → getTask → findAcItems).
    expect(view.acceptanceCriteria.map((t) => t.taskId)).toEqual(['TASK-909', 'TASK-914'])
    expect(view.acceptanceCriteria[0].acItems).toEqual([
      'Response carries seller_name',
      'Null when not crawled'
    ])

    // Edge case derived from gotcha trigger (26%) + context (empty/populated rows).
    expect(view.edgeCases).toHaveLength(1)
    expect(view.edgeCases[0]).toContain('26%')
    expect(view.edgeCases[0]).toContain('empty and populated')

    // Regression scope = shipped (DONE) realized tasks, incl. the FE Source column.
    expect(view.regressionScope).toContain('FE: add Source column to crawler list')
    expect(bundle.honesty.used).toEqual(
      expect.arrayContaining(['acceptance-criteria', 'edge-cases', 'regression-scope'])
    )
  })
})
