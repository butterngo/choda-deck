import { findAcItems } from './ac-check'
import { AC_METHODS, acTag, methodAllowed, type AcMethod, type AcTag } from './ac-tag'

// TASK-2597 — how well a task's acceptance criteria are proven, one row per
// criterion. Butter, 2026-10-21: "tôi muốn biết chắc chắn 1 cái luôn chạy nó
// phải đảm bảo hết". The Runs screen shows these rows; G2's test report must
// count the same way, which is why the rule lives here and not in the adapter.
//
// Rows follow findAcItems — the parser ac_check flips with — so a row's index
// is exactly the acIndex an ac_check event names.

export type AcState = 'covered' | 'weak' | 'open' | 'human'

/** One ac_check event, as stored in its session event payload. */
export interface AcTick {
  acIndex: number
  method: string | null
  ref: string | null
  evidence: string | null
  /** Event time; the newest tick of an index wins. */
  createdAt: string
}

export interface AcRow {
  index: number
  text: string
  tag: AcTag | null
  checked: boolean
  method: string | null
  ref: string | null
  evidence: string | null
  state: AcState
}

export interface AcCoverage {
  covered: number
  weak: number
  open: number
  human: number
  total: number
}

function asMethod(method: string | null): AcMethod | null {
  return method !== null && (AC_METHODS as readonly string[]).includes(method) ? (method as AcMethod) : null
}

/**
 * - checked: a human AC is covered; an untagged AC is covered whatever proved it;
 *   a tagged AC is covered only by a method its tag allows, else weak — which is
 *   where every tick made before ac_check recorded a method lands.
 * - unchecked: open, unless the tag is human (that one waits on a person).
 */
export function acState(tag: AcTag | null, checked: boolean, method: string | null): AcState {
  if (!checked) return tag === 'human' ? 'human' : 'open'
  if (tag === null || tag === 'human') return 'covered'
  return methodAllowed(tag, asMethod(method)) ? 'covered' : 'weak'
}

export function acRows(body: string | null, ticks: AcTick[]): AcRow[] {
  const newest = new Map<number, AcTick>()
  for (const t of ticks) {
    const seen = newest.get(t.acIndex)
    if (!seen || t.createdAt >= seen.createdAt) newest.set(t.acIndex, t)
  }
  return findAcItems(body ?? '').map((item, index) => {
    const tick = newest.get(index) ?? null
    const tag = acTag(item.text)
    const method = tick?.method ?? null
    return {
      index,
      text: item.text,
      tag,
      checked: item.checked,
      method,
      ref: tick?.ref ?? null,
      evidence: tick?.evidence ?? null,
      state: acState(tag, item.checked, method)
    }
  })
}

export function acCoverage(rows: AcRow[]): AcCoverage {
  const out: AcCoverage = { covered: 0, weak: 0, open: 0, human: 0, total: rows.length }
  for (const r of rows) out[r.state]++
  return out
}
