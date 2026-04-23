import { describe, it, expect } from 'vitest'
import { defaultBody } from '../task-tools'

describe('defaultBody template', () => {
  it('contains the 4 canonical sections', () => {
    const body = defaultBody('TASK-001', 'Example')
    expect(body).toContain('## Context')
    expect(body).toContain('## Acceptance')
    expect(body).toContain('## Test Plan')
    expect(body).toContain('## Related')
  })

  it('does NOT include removed legacy sections', () => {
    const body = defaultBody('TASK-001', 'Example')
    expect(body).not.toContain('## Why')
    expect(body).not.toContain('## Acceptance criteria')
    expect(body).not.toContain('## Scope')
    expect(body).not.toContain('## Out of scope')
    expect(body).not.toContain('## Notes')
  })

  it('interpolates id + title into H1', () => {
    const body = defaultBody('TASK-042', 'Wire feature X')
    expect(body).toMatch(/^# TASK-042: Wire feature X\n/)
  })

  it('seeds Acceptance with an empty checkbox for the first criterion', () => {
    const body = defaultBody('TASK-001', 'x')
    expect(body).toContain('## Acceptance\n\n- [ ]')
  })
})
