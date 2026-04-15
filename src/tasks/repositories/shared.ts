import type { DerivedProgress } from '../task-types'

export type Param = string | number | null | undefined | boolean

export function now(): string {
  return new Date().toISOString()
}

export function derivedProgress(total: number, done: number, inProgress: number): DerivedProgress {
  const status = total === 0 ? 'planned'
    : done === total ? 'completed'
    : (done > 0 || inProgress > 0) ? 'active'
    : 'planned'
  const percent = total === 0 ? 0 : Math.round((done / total) * 100)
  return { total, done, inProgress, status, percent }
}
