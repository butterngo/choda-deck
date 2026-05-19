import type { InboxItem } from './task-types'

export const STALE_RAW_DAYS = 3

export interface StaleRawWarning {
  count: number
  oldestId: string
  ageDays: number
}

export function computeStaleRawWarning(
  items: InboxItem[],
  now: Date = new Date(),
  thresholdDays: number = STALE_RAW_DAYS
): StaleRawWarning | null {
  const stale = items
    .filter((i) => i.status === 'raw')
    .filter((i) => ageInDays(i.createdAt, now) >= thresholdDays)
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  if (stale.length === 0) return null
  const oldest = stale[0]
  return {
    count: stale.length,
    oldestId: oldest.id,
    ageDays: Math.floor(ageInDays(oldest.createdAt, now))
  }
}

function ageInDays(createdAt: string, now: Date): number {
  const created = new Date(createdAt).getTime()
  return (now.getTime() - created) / (1000 * 60 * 60 * 24)
}
