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
