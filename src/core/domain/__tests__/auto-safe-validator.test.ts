import { describe, it, expect } from 'vitest'
import { validateAutoSafeTask } from '../auto-safe-validator'
import type { Task } from '../task-types'

const baseTask: Task = {
  id: 'TASK-999',
  projectId: 'choda-deck',
  parentTaskId: null,
  title: 'Test task',
  status: 'READY',
  priority: 'medium',
  labels: [],
  dueDate: null,
  pinned: false,
  filePath: null,
  body: null,
  blockedBy: [],
  createdAt: '2026-05-05T00:00:00.000Z',
  updatedAt: '2026-05-05T00:00:00.000Z'
}

const taskWith = (body: string): Task => ({ ...baseTask, body })

const validBody = `# TASK-999: example

## Acceptance

- [ ] \`pnpm run lint\` clean
- [ ] tests pass with \`pnpm test\`

## File Pointers

- src/core/domain/foo.ts (new)

## Scope

~2h
`

describe('validateAutoSafeTask', () => {
  it('passes a well-formed task body', () => {
    const result = validateAutoSafeTask(taskWith(validBody))
    expect(result).toEqual({ valid: true, errors: [] })
  })

  it('fails when body is empty', () => {
    const result = validateAutoSafeTask({ ...baseTask, body: null })
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toMatch(/body is empty/i)
  })

  it('fails when AC section has no verifiable shell command', () => {
    const body = validBody.replace(
      /## Acceptance[\s\S]*?(?=## File)/,
      '## Acceptance\n\n- [ ] do the thing\n- [ ] also this\n\n'
    )
    const result = validateAutoSafeTask(taskWith(body))
    expect(result.valid).toBe(false)
    expect(result.errors).toContain(
      '## Acceptance has no verifiable shell command (need `pnpm `, `node `, or a ```bash code block)'
    )
  })

  it('fails when File Pointers section is missing', () => {
    const body = validBody.replace(/## File Pointers[\s\S]*?(?=## Scope)/, '')
    const result = validateAutoSafeTask(taskWith(body))
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('Missing ## File Pointers section')
  })

  it('fails when scope exceeds 3h', () => {
    const body = validBody.replace('~2h', '~5h')
    const result = validateAutoSafeTask(taskWith(body))
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('## Scope estimate 5h exceeds auto-safe ceiling of 3h')
  })

  it('uses the upper bound of a scope range (2-4h fails)', () => {
    const body = validBody.replace('~2h', '~2-4h')
    const result = validateAutoSafeTask(taskWith(body))
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('## Scope estimate 4h exceeds auto-safe ceiling of 3h')
  })

  it('fails when body mentions build:mcp but AC has no smoke step', () => {
    const body = `# TASK-999: example

## Acceptance

- [ ] \`pnpm run lint\` clean

## File Pointers

- src/adapters/mcp/mcp-tools/foo.ts

## Scope

~1h

Note: this changes \`build:mcp\` output.
`
    const result = validateAutoSafeTask(taskWith(body))
    expect(result.valid).toBe(false)
    expect(result.errors).toContain(
      '## Acceptance must include a smoke step (body mentions build:mcp / build:cli / loader / asset copy)'
    )
  })

  it('fails when body mentions build:cli but AC has no smoke step', () => {
    const body = `# TASK-999: example

## Acceptance

- [ ] \`pnpm run lint\` clean
- [ ] \`pnpm test\` exits 0

## File Pointers

- src/adapters/cli/commands/foo.ts

## Scope

~1h

Touches the \`build:cli\` bundle output.
`
    const result = validateAutoSafeTask(taskWith(body))
    expect(result.valid).toBe(false)
    expect(result.errors).toContain(
      '## Acceptance must include a smoke step (body mentions build:mcp / build:cli / loader / asset copy)'
    )
  })

  it('passes when body mentions build:cli and AC has a smoke step via pnpm run build:cli', () => {
    const body = `# TASK-999: example

## Acceptance

- [ ] \`pnpm run lint\` clean
- [ ] \`pnpm run build:cli\` then \`node dist/cli.cjs --help\` exits 0

## File Pointers

- src/adapters/cli/commands/foo.ts

## Scope

~1h

Touches the \`build:cli\` bundle output.
`
    const result = validateAutoSafeTask(taskWith(body))
    expect(result).toEqual({ valid: true, errors: [] })
  })

  it('passes when body mentions loader and AC has a smoke step', () => {
    const body = `# TASK-999: example

## Acceptance

- [ ] \`pnpm run lint\` clean
- [ ] **Smoke**: \`pnpm run build:mcp\` then reconnect MCP

## File Pointers

- src/adapters/mcp/mcp-tools/loader.ts

## Scope

~2h

Touches the asset loader.
`
    const result = validateAutoSafeTask(taskWith(body))
    expect(result).toEqual({ valid: true, errors: [] })
  })

  it('reports multiple errors at once when many fields are missing', () => {
    const body = '# TASK-999: empty\n\nNo sections here.'
    const result = validateAutoSafeTask(taskWith(body))
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThanOrEqual(3)
  })

  it('accepts a fenced bash block as the verifiable shell command', () => {
    const body = `# TASK-999: example

## Acceptance

- [ ] run the command below

\`\`\`bash
git status
\`\`\`

## File Pointers

- scripts/foo.sh

## Scope

~1h
`
    const result = validateAutoSafeTask(taskWith(body))
    expect(result).toEqual({ valid: true, errors: [] })
  })
})
