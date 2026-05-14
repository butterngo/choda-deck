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
      { cmd: 'pnpm test src/foo.test.ts', expectedExit: 0 },
      { cmd: 'pnpm run lint', expectedExit: 0 }
    ])
  })

  it('extracts inline backticked node commands', () => {
    const body = '## Acceptance\n- [ ] Smoke: `node dist/server.cjs --check`'
    expect(parseAcCommands(body)).toEqual([
      { cmd: 'node dist/server.cjs --check', expectedExit: 0 }
    ])
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
    expect(parseAcCommands(body)).toEqual([
      { cmd: 'pnpm install', expectedExit: 0 },
      { cmd: 'pnpm run build', expectedExit: 0 }
    ])
  })

  it('extracts bare lines starting with pnpm/node after list markers', () => {
    const body = [
      '## Acceptance',
      '- pnpm test',
      '* node scripts/check.mjs',
      'pnpm run lint'
    ].join('\n')
    expect(parseAcCommands(body)).toEqual([
      { cmd: 'pnpm test', expectedExit: 0 },
      { cmd: 'node scripts/check.mjs', expectedExit: 0 },
      { cmd: 'pnpm run lint', expectedExit: 0 }
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
    expect(parseAcCommands(body)).toEqual([
      { cmd: 'pnpm a', expectedExit: 0 },
      { cmd: 'pnpm b', expectedExit: 0 },
      { cmd: 'pnpm c', expectedExit: 0 },
      { cmd: 'pnpm d', expectedExit: 0 }
    ])
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
    expect(parseAcCommands(body)).toEqual([
      { cmd: 'pnpm test', expectedExit: 0 },
      { cmd: 'pnpm run lint', expectedExit: 0 }
    ])
  })

  it('stops at top-level # heading too', () => {
    const body = [
      '## Acceptance',
      '- [ ] `pnpm test`',
      '',
      '# Section',
      '- [ ] `pnpm not-this`'
    ].join('\n')
    expect(parseAcCommands(body)).toEqual([{ cmd: 'pnpm test', expectedExit: 0 }])
  })

  it('extracts multiple inline commands on the same line', () => {
    const body = '## Acceptance\n- [ ] Run both: `pnpm a` then `pnpm b`'
    expect(parseAcCommands(body)).toEqual([
      { cmd: 'pnpm a', expectedExit: 0 },
      { cmd: 'pnpm b', expectedExit: 0 }
    ])
  })

  it('matches ## Acceptance heading case-insensitively', () => {
    const body = '## acceptance\n- [ ] `pnpm test`'
    expect(parseAcCommands(body)).toEqual([{ cmd: 'pnpm test', expectedExit: 0 }])
  })

  it('ignores backticked commands that are not pnpm/node', () => {
    const body = '## Acceptance\n- [ ] `git status` and `pnpm test`'
    expect(parseAcCommands(body)).toEqual([{ cmd: 'pnpm test', expectedExit: 0 }])
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
    expect(parseAcCommands(body)).toEqual([{ cmd: 'pnpm test', expectedExit: 0 }])
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
      { cmd: 'pnpm test src/core/domain/lifecycle/queue-lifecycle-service.test.ts', expectedExit: 0 },
      { cmd: 'pnpm test src/core/domain/lifecycle/session-lifecycle-service.test.ts', expectedExit: 0 },
      { cmd: 'pnpm test src/core/domain/lifecycle/ac-parser.test.ts', expectedExit: 0 },
      { cmd: 'pnpm run lint', expectedExit: 0 },
      { cmd: 'pnpm run build:mcp', expectedExit: 0 }
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
    expect(parseAcCommands(body)).toEqual([
      { cmd: 'pnpm install \\', expectedExit: 0 },
      { cmd: '--frozen-lockfile', expectedExit: 0 }
    ])
  })

  describe('inline "exit N" hint (TASK-740)', () => {
    it('picks up expected non-zero exit from same-line prose after the command', () => {
      const body = '## Acceptance\n- [ ] `node dist/cli.cjs run-queue --workspace nonexistent --dry-run` exit 3 (workspace-not-found path)'
      expect(parseAcCommands(body)).toEqual([
        {
          cmd: 'node dist/cli.cjs run-queue --workspace nonexistent --dry-run',
          expectedExit: 3
        }
      ])
    })

    it('picks up expected exit from prose BEFORE the command on the same line', () => {
      const body = '## Acceptance\n- [ ] Expect exit 7: `node scripts/failer.mjs`'
      expect(parseAcCommands(body)).toEqual([
        { cmd: 'node scripts/failer.mjs', expectedExit: 7 }
      ])
    })

    it('is case-insensitive for the "exit" keyword', () => {
      const body = '## Acceptance\n- [ ] `node x.mjs` EXIT 5'
      expect(parseAcCommands(body)).toEqual([{ cmd: 'node x.mjs', expectedExit: 5 }])
    })

    it('defaults expectedExit=0 when no hint is on the line', () => {
      const body = '## Acceptance\n- [ ] `pnpm run lint`'
      expect(parseAcCommands(body)).toEqual([{ cmd: 'pnpm run lint', expectedExit: 0 }])
    })

    it('applies the same hint to every backticked command on the line', () => {
      // Two backticks on one line, one "exit N" hint — both inherit it. Documented
      // simplification; if authors want different expected exits, split into 2 bullets.
      const body = '## Acceptance\n- [ ] `node a.mjs` and `node b.mjs` exit 2'
      expect(parseAcCommands(body)).toEqual([
        { cmd: 'node a.mjs', expectedExit: 2 },
        { cmd: 'node b.mjs', expectedExit: 2 }
      ])
    })

    it('does NOT apply prose hint to commands inside fenced bash blocks', () => {
      // "exit 99" lives in the prose around the fence, but the fence body has its own
      // context — inside a bash block, expectedExit is always 0.
      const body = [
        '## Acceptance',
        '',
        'exit 99 in surrounding prose should be ignored:',
        '',
        '```bash',
        'pnpm test',
        '```'
      ].join('\n')
      expect(parseAcCommands(body)).toEqual([{ cmd: 'pnpm test', expectedExit: 0 }])
    })

    it('bare-line commands do NOT get exit-hint detection (would corrupt the cmd)', () => {
      // Authors who want neg-exit assertions must use backticks. Bare lines swallow
      // the entire stripped line as the cmd; mixing in "exit N" parsing would mean
      // the executed command includes prose words.
      const body = ['## Acceptance', '- pnpm run lint'].join('\n')
      expect(parseAcCommands(body)).toEqual([{ cmd: 'pnpm run lint', expectedExit: 0 }])
    })
  })
})
