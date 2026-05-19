import { describe, it, expect } from 'vitest'
import { computeStaleRawWarning, STALE_RAW_DAYS } from '../inbox-triage-policy'
import type { InboxItem } from '../task-types'

function makeItem(overrides: Partial<InboxItem>): InboxItem {
  return {
    id: 'INBOX-1',
    projectId: 'p',
    content: 'x',
    status: 'raw',
    linkedTaskId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  }
}

describe('computeStaleRawWarning', () => {
  const now = new Date('2026-05-19T00:00:00Z')

  it('returns null when no raw items', () => {
    const result = computeStaleRawWarning([], now)
    expect(result).toBeNull()
  })

  it('returns null when all raw items are within threshold', () => {
    const items = [
      makeItem({ id: 'INBOX-1', createdAt: '2026-05-18T00:00:00Z' }),
      makeItem({ id: 'INBOX-2', createdAt: '2026-05-17T12:00:00Z' })
    ]
    const result = computeStaleRawWarning(items, now)
    expect(result).toBeNull()
  })

  it('emits warning when at least one raw item is older than 3 days', () => {
    const items = [
      makeItem({ id: 'INBOX-1', createdAt: '2026-05-15T00:00:00Z' }), // 4 days old
      makeItem({ id: 'INBOX-2', createdAt: '2026-05-18T00:00:00Z' }) // 1 day old
    ]
    const result = computeStaleRawWarning(items, now)
    expect(result).not.toBeNull()
    expect(result!.count).toBe(1)
    expect(result!.oldestId).toBe('INBOX-1')
    expect(result!.ageDays).toBe(4)
  })

  it('reports the oldest stale id and counts only stale items', () => {
    const items = [
      makeItem({ id: 'INBOX-1', createdAt: '2026-05-10T00:00:00Z' }), // 9 days
      makeItem({ id: 'INBOX-2', createdAt: '2026-05-12T00:00:00Z' }), // 7 days
      makeItem({ id: 'INBOX-3', createdAt: '2026-05-18T00:00:00Z' }) // 1 day — not stale
    ]
    const result = computeStaleRawWarning(items, now)
    expect(result!.count).toBe(2)
    expect(result!.oldestId).toBe('INBOX-1')
    expect(result!.ageDays).toBe(9)
  })

  it('ignores non-raw items even if old', () => {
    const items = [
      makeItem({ id: 'INBOX-1', status: 'researching', createdAt: '2026-05-10T00:00:00Z' }),
      makeItem({ id: 'INBOX-2', status: 'archived', createdAt: '2026-05-10T00:00:00Z' }),
      makeItem({ id: 'INBOX-3', status: 'converted', createdAt: '2026-05-10T00:00:00Z' })
    ]
    const result = computeStaleRawWarning(items, now)
    expect(result).toBeNull()
  })

  it('uses STALE_RAW_DAYS=3 as default threshold', () => {
    const items = [makeItem({ createdAt: '2026-05-16T00:00:00Z' })] // exactly 3 days
    const result = computeStaleRawWarning(items, now)
    expect(STALE_RAW_DAYS).toBe(3)
    expect(result).not.toBeNull()
    expect(result!.count).toBe(1)
  })

  it('respects custom threshold', () => {
    const items = [makeItem({ createdAt: '2026-05-13T00:00:00Z' })] // 6 days
    const result = computeStaleRawWarning(items, now, 7)
    expect(result).toBeNull()
  })
})
