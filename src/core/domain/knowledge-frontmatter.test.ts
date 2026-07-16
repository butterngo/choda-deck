import { describe, it, expect } from 'vitest'
import { parseFrontmatter, serializeFrontmatter } from './knowledge-frontmatter'
import type { KnowledgeFrontmatter } from './knowledge-types'

const base: Omit<KnowledgeFrontmatter, 'structured'> = {
  type: 'feature',
  title: 'Crawler list UI enhancements',
  projectId: 'pim',
  scope: 'project',
  refs: [],
  createdAt: '2026-05-29',
  lastVerifiedAt: '2026-05-29'
}

describe('frontmatter structured fields (TASK-988)', () => {
  it('round-trips feature structured fields', () => {
    const fm: KnowledgeFrontmatter = {
      ...base,
      structured: {
        anchorTaskId: 'TASK-910',
        realizesTasks: ['TASK-909', 'TASK-910', 'TASK-914'],
        inWorkspaces: ['pim-trading-api', 'remote-pim-portal'],
        effortBand: 'L',
        status: 'blocked'
      }
    }
    const parsed = parseFrontmatter(serializeFrontmatter(fm, 'body text'))
    expect(parsed.frontmatter.structured).toEqual(fm.structured)
    expect(parsed.body.trim()).toBe('body text')
  })

  it('round-trips gotcha affectedFeatureId', () => {
    const fm: KnowledgeFrontmatter = {
      ...base,
      type: 'gotcha',
      title: 'seller name not captured',
      structured: { affectedFeatureId: 'feature-crawler-list-ui-enhancements' }
    }
    const parsed = parseFrontmatter(serializeFrontmatter(fm, 'b'))
    expect(parsed.frontmatter.structured?.affectedFeatureId).toBe(
      'feature-crawler-list-ui-enhancements'
    )
  })

  it('omits the structured block entirely for the original two-line types', () => {
    const fm: KnowledgeFrontmatter = { ...base, type: 'decision', structured: undefined }
    const text = serializeFrontmatter(fm, 'b')
    expect(text).not.toContain('effortBand')
    expect(text).not.toContain('anchorTaskId')
    expect(parseFrontmatter(text).frontmatter.structured).toBeUndefined()
  })

  it('rejects an invalid effortBand', () => {
    const bad = serializeFrontmatter(base as KnowledgeFrontmatter, 'b').replace(
      'lastVerifiedAt: 2026-05-29',
      'lastVerifiedAt: 2026-05-29\neffortBand: XXL'
    )
    expect(() => parseFrontmatter(bad)).toThrow(/effortBand/)
  })

  it('parses an empty list as an empty array (no entry emitted)', () => {
    const fm: KnowledgeFrontmatter = {
      ...base,
      structured: { anchorTaskId: 'TASK-1', realizesTasks: [] }
    }
    const text = serializeFrontmatter(fm, 'b')
    // empty list is not serialized; only anchorTaskId survives
    expect(text).toContain('anchorTaskId: TASK-1')
    expect(text).not.toContain('realizesTasks')
  })
})

// `status` is per-node-type: a feature has a DELIVERY status, an ADR/spike has a
// LIFECYCLE status. Enforcing FEATURE_STATUSES on every type threw a hard
// FrontmatterParseError that made the entire entry unreadable via knowledge_get —
// it bricked 7 real entries (ADR-019, ADR-021, ADR-023-auto-safe, ADR-024 all
// carry `status: superseded`; the gateway's ADR-006 carries `implemented`; two
// spikes carry `complete`).
describe('status is validated per node type', () => {
  const withStatus = (type: KnowledgeFrontmatter['type'], status: string): string =>
    serializeFrontmatter({ ...base, type } as KnowledgeFrontmatter, 'b').replace(
      'lastVerifiedAt: 2026-05-29',
      `lastVerifiedAt: 2026-05-29\nstatus: ${status}`
    )

  it('accepts a lifecycle status on a decision (the ADR-024 regression)', () => {
    const parsed = parseFrontmatter(withStatus('decision', 'superseded'))
    expect(parsed.frontmatter.structured?.status).toBe('superseded')
  })

  it('accepts `complete` on a spike', () => {
    const parsed = parseFrontmatter(withStatus('spike', 'complete'))
    expect(parsed.frontmatter.structured?.status).toBe('complete')
  })

  it('accepts `implemented` on a decision', () => {
    const parsed = parseFrontmatter(withStatus('decision', 'implemented'))
    expect(parsed.frontmatter.structured?.status).toBe('implemented')
  })

  it('still accepts a delivery status on a feature', () => {
    const parsed = parseFrontmatter(withStatus('feature', 'shipped'))
    expect(parsed.frontmatter.structured?.status).toBe('shipped')
  })

  it('rejects a lifecycle status on a feature — wrong vocabulary', () => {
    expect(() => parseFrontmatter(withStatus('feature', 'superseded'))).toThrow(
      /invalid status for type feature/
    )
  })

  it('rejects a delivery status on a decision — wrong vocabulary', () => {
    expect(() => parseFrontmatter(withStatus('decision', 'shipped'))).toThrow(
      /invalid status for type decision/
    )
  })

  it('rejects a garbage status on any type', () => {
    expect(() => parseFrontmatter(withStatus('decision', 'banana'))).toThrow(/invalid status/)
  })
})
