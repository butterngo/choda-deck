// TASK-2247 — the task template a converted draft must follow (TASK-2241:
// "every task follows the template, so exactly one person reviews and
// converts"). Mirrors defaultBody in adapters/mcp/mcp-tools/task-tools.ts:
// four sections, and at least one real checkbox under ## Acceptance. The
// checkbox parser is the one ac_check uses, so "a criterion" means the same
// thing at conversion time as at verification time; the blank `- [ ]`
// placeholder of defaultBody is not a criterion.

import { findAcItems } from './ac-check'

export const TEMPLATE_SECTIONS = ['Context', 'Acceptance', 'Test Plan', 'Related'] as const

export function templateViolations(body: string | undefined | null): string[] {
  const text = body ?? ''
  const lines = text.split(/\r?\n/)
  const violations: string[] = []
  for (const section of TEMPLATE_SECTIONS) {
    const heading = new RegExp(`^##\\s+${section.replace(' ', '\\s+')}\\s*$`, 'i')
    if (!lines.some((line) => heading.test(line))) violations.push(`missing ## ${section}`)
  }
  const criteria = findAcItems(text).filter((item) => item.text.length > 0)
  if (!violations.includes('missing ## Acceptance') && criteria.length === 0) {
    violations.push('empty ## Acceptance section — add at least one "- [ ] ..." criterion')
  }
  return violations
}
