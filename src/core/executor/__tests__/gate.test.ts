import { describe, expect, it } from 'vitest'
import type { Task } from '../../domain/task-types'
import { validateLabelGate } from '../../../adapters/cli/commands/run'

const VALID_BODY = `## Acceptance

- [ ] Run \`pnpm playwright test\` — exit 0

## File Pointers

- \`remote-workflow/e2e/foo.spec.ts\`

## Scope

~2h scaffold.
`

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: 'TASK-001',
    projectId: 'choda-deck',
    parentTaskId: null,
    title: 'sample',
    status: 'TODO',
    priority: null,
    labels: ['fe-playwright-test', 'auto-safe'],
    dueDate: null,
    pinned: false,
    filePath: null,
    body: VALID_BODY,
    blockedBy: [],
    createdAt: '',
    updatedAt: '',
    ...overrides
  }
}

describe('validateLabelGate', () => {
  it('passes when both labels present + auto-safe body shape valid', () => {
    const r = validateLabelGate(makeTask({}))
    expect(r.ok).toBe(true)
    expect(r.errors).toEqual([])
  })

  it('rejects missing fe-playwright-test label', () => {
    const r = validateLabelGate(makeTask({ labels: ['auto-safe'] }))
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toContain('fe-playwright-test')
  })

  it('rejects missing auto-safe label', () => {
    const r = validateLabelGate(makeTask({ labels: ['fe-playwright-test'] }))
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('auto-safe'))).toBe(true)
  })

  it('rejects when auto-safe validator fails (empty body)', () => {
    const r = validateLabelGate(makeTask({ body: '' }))
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.startsWith('auto-safe:'))).toBe(true)
  })
})
