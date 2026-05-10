import { describe, it, expect } from 'vitest'
import { parseAcCommands } from './ac-parser'

describe('parseAcCommands', () => {
  it('returns [] when body has no ## Acceptance section', () => {
    const body = '## Goal\nDo a thing\n\n## Notes\nNothing here.'
    expect(parseAcCommands(body)).toEqual([])
  })

  it('returns [] when ## Acceptance section is empty', () => {
    const body = '## Acceptance\n\n## Notes\nAfter.'
    expect(parseAcCommands(body)).toEqual([])
  })

  it('extracts inline backticked pnpm commands from checkbox items', () => {
    const body = [
      '## Acceptance',
      '',
      '- [ ] Unit tests pass: `pnpm test src/foo.test.ts`',
      '- [ ] Lint clean: `pnpm run lint`',
      '',
      '## Notes'
    ].join('\n')
    expect(parseAcCommands(body)).toEqual([
      'pnpm test src/foo.test.ts',
      'pnpm run lint'
    ])
  })

  it('extracts inline backticked node commands', () => {
    const body = '## Acceptance\n- [ ] Smoke: `node dist/server.cjs --check`'
    expect(parseAcCommands(body)).toEqual(['node dist/server.cjs --check'])
  })

  it('extracts content of fenced bash blocks (skipping comments and blanks)', () => {
    const body = [
      '## Acceptance',
      '',
      '```bash',
      '# install',
      'pnpm install',
      '',
      'pnpm run build',
      '```'
    ].join('\n')
    expect(parseAcCommands(body)).toEqual(['pnpm install', 'pnpm run build'])
  })

  it('extracts bare lines starting with pnpm/node after list markers', () => {
    const body = [
      '## Acceptance',
      '- pnpm test',
      '* node scripts/check.mjs',
      'pnpm run lint'
    ].join('\n')
    expect(parseAcCommands(body)).toEqual([
      'pnpm test',
      'node scripts/check.mjs',
      'pnpm run lint'
    ])
  })

  it('preserves source order across mixed inline + fenced sources', () => {
    const body = [
      '## Acceptance',
      '- [ ] Step A: `pnpm a`',
      '',
      '```bash',
      'pnpm b',
      'pnpm c',
      '```',
      '',
      '- [ ] Step D: `pnpm d`'
    ].join('\n')
    expect(parseAcCommands(body)).toEqual(['pnpm a', 'pnpm b', 'pnpm c', 'pnpm d'])
  })

  it('keeps ### sub-sections inside ## Acceptance and stops at next ## heading', () => {
    const body = [
      '## Acceptance',
      '- [ ] `pnpm test`',
      '',
      '### Behavior contract',
      '- [ ] `pnpm run lint`',
      '',
      '## Notes',
      '- [ ] `pnpm should-not-pick-this-up`'
    ].join('\n')
    expect(parseAcCommands(body)).toEqual(['pnpm test', 'pnpm run lint'])
  })

  it('stops at top-level # heading too', () => {
    const body = [
      '## Acceptance',
      '- [ ] `pnpm test`',
      '',
      '# Section',
      '- [ ] `pnpm not-this`'
    ].join('\n')
    expect(parseAcCommands(body)).toEqual(['pnpm test'])
  })

  it('extracts multiple inline commands on the same line', () => {
    const body = '## Acceptance\n- [ ] Run both: `pnpm a` then `pnpm b`'
    expect(parseAcCommands(body)).toEqual(['pnpm a', 'pnpm b'])
  })

  it('matches ## Acceptance heading case-insensitively', () => {
    const body = '## acceptance\n- [ ] `pnpm test`'
    expect(parseAcCommands(body)).toEqual(['pnpm test'])
  })

  it('ignores backticked commands that are not pnpm/node', () => {
    const body = '## Acceptance\n- [ ] `git status` and `pnpm test`'
    expect(parseAcCommands(body)).toEqual(['pnpm test'])
  })

  it('ignores bash blocks outside ## Acceptance', () => {
    const body = [
      '## Goal',
      '```bash',
      'pnpm not-acceptance',
      '```',
      '',
      '## Acceptance',
      '- [ ] `pnpm test`'
    ].join('\n')
    expect(parseAcCommands(body)).toEqual(['pnpm test'])
  })

  it('handles TASK-698-shaped body with inline backticks across multiple checkboxes', () => {
    const body = [
      '## Goal',
      'irrelevant',
      '',
      '## Acceptance',
      '',
      '- [ ] Unit tests pass: `pnpm test src/core/domain/lifecycle/queue-lifecycle-service.test.ts`',
      '- [ ] Unit tests pass: `pnpm test src/core/domain/lifecycle/session-lifecycle-service.test.ts` (existing tests still pass + new abandonSession tests)',
      '- [ ] Unit tests pass: `pnpm test src/core/domain/lifecycle/ac-parser.test.ts`',
      '- [ ] Lint clean: `pnpm run lint`',
      '- [ ] Smoke after build: `pnpm run build:mcp` exits 0 (services imported by lifecycle index, must compile)',
      '',
      '### Behavior contract (must verify in tests)',
      '',
      '1. **`abandonSession(...)` new method**:',
      '   - does not run anything',
      '',
      '## File Pointers'
    ].join('\n')
    expect(parseAcCommands(body)).toEqual([
      'pnpm test src/core/domain/lifecycle/queue-lifecycle-service.test.ts',
      'pnpm test src/core/domain/lifecycle/session-lifecycle-service.test.ts',
      'pnpm test src/core/domain/lifecycle/ac-parser.test.ts',
      'pnpm run lint',
      'pnpm run build:mcp'
    ])
  })

  it('handles fenced bash block with shell continuation as separate lines', () => {
    const body = [
      '## Acceptance',
      '```bash',
      'pnpm install \\',
      '  --frozen-lockfile',
      '```'
    ].join('\n')
    // Trailing `\` is preserved verbatim — runner concerns, not parser concerns.
    expect(parseAcCommands(body)).toEqual(['pnpm install \\', '--frozen-lockfile'])
  })
})
