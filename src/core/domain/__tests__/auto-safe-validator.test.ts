import { describe, it, expect } from 'vitest'
import { suggestFixesFor, validateAutoSafeTask } from '../auto-safe-validator'
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

describe('suggestFixesFor', () => {
  it('returns an empty array when there are no errors', () => {
    expect(suggestFixesFor([])).toEqual([])
  })

  it('preserves order — suggestion[i] ↔ error[i]', () => {
    const errors = ['Missing ## Scope section', 'Missing ## File Pointers section']
    const out = suggestFixesFor(errors)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatch(/scope/i)
    expect(out[1]).toMatch(/file pointers/i)
  })

  it.each([
    {
      label: 'empty body',
      body: null as string | null,
      match: /fill in the task body/i
    },
    {
      label: 'missing AC',
      body: '# T\n\n## File Pointers\n- src/foo.ts\n\n## Scope\n~1h\n',
      match: /add an `## Acceptance` section/i
    },
    {
      label: 'AC without shell command',
      body: '# T\n\n## Acceptance\n- [ ] do the thing\n\n## File Pointers\n- src/foo.ts\n\n## Scope\n~1h\n',
      match: /verifiable shell command/i
    },
    {
      label: 'missing File Pointers',
      body: '# T\n\n## Acceptance\n- [ ] `pnpm test`\n\n## Scope\n~1h\n',
      match: /add a `## File Pointers` section/i
    },
    {
      label: 'File Pointers without concrete path',
      body: '# T\n\n## Acceptance\n- [ ] `pnpm test`\n\n## File Pointers\n- the thing\n\n## Scope\n~1h\n',
      match: /concrete file path/i
    },
    {
      label: 'missing Scope',
      body: '# T\n\n## Acceptance\n- [ ] `pnpm test`\n\n## File Pointers\n- src/foo.ts\n',
      match: /add a `## Scope` section/i
    },
    {
      label: 'Scope without parseable hours',
      body: '# T\n\n## Acceptance\n- [ ] `pnpm test`\n\n## File Pointers\n- src/foo.ts\n\n## Scope\nsmall task\n',
      match: /express scope in hours/i
    },
    {
      label: 'Scope exceeds ceiling',
      body: '# T\n\n## Acceptance\n- [ ] `pnpm test`\n\n## File Pointers\n- src/foo.ts\n\n## Scope\n~5h\n',
      match: /ceiling/i
    },
    {
      label: 'missing smoke step',
      body: '# T\n\n## Acceptance\n- [ ] `pnpm test`\n\n## File Pointers\n- src/foo.ts\n\n## Scope\n~1h\n\nbuild:mcp note\n',
      match: /smoke step/i
    }
  ])('maps "$label" to an actionable suggestion', ({ body, match }) => {
    const task: Task = { ...baseTask, body }
    const { errors } = validateAutoSafeTask(task)
    expect(errors.length).toBeGreaterThan(0)
    const suggestions = suggestFixesFor(errors)
    expect(suggestions).toHaveLength(errors.length)
    expect(suggestions.some((s) => match.test(s))).toBe(true)
    expect(suggestions.every((s) => !/no suggestion mapped/i.test(s))).toBe(true)
  })

  it('never returns the "no suggestion mapped" fallback for any error emitted by validateAutoSafeTask', () => {
    const bodies: Array<string | null> = [
      null,
      '# T\n\nNo sections here.',
      '# T\n\n## Acceptance\n- [ ] do thing\n\n## File Pointers\n- src/foo.ts\n\n## Scope\n~10h\n',
      '# T\n\n## Acceptance\n- [ ] `pnpm test`\n\n## File Pointers\n- src/foo.ts\n\n## Scope\nsmall\n',
      '# T\n\n## Acceptance\n- [ ] `pnpm test`\n\n## File Pointers\n- src/foo.ts\n\n## Scope\n~1h\n\nbuild:mcp note\n'
    ]
    for (const body of bodies) {
      const { errors } = validateAutoSafeTask({ ...baseTask, body })
      const suggestions = suggestFixesFor(errors)
      for (const s of suggestions) {
        expect(s).not.toMatch(/no suggestion mapped/i)
      }
    }
  })
})
