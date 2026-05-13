import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { composePrewarmPrefix } from './prewarm-compose'

/**
 * TASK-727 spike: prewarm prefix MUST be cwd-independent so per-task worktrees
 * (ADR-019 queue start) reuse the same prompt cache. If output bakes absolute
 * paths from cwd, every worktree misses the cache → token cost N×.
 */
describe('composePrewarmPrefix cwd-independence (TASK-727)', () => {
  let cwdA: string
  let cwdB: string

  const fooContent = Array.from({ length: 25 }, (_, i) => `line${i + 1}`).join('\n') + '\n'
  const barContent = 'barA\nbarB\nbarC\nbarD\nbarE\nbarF\n'

  beforeEach(async () => {
    cwdA = await fsp.mkdtemp(path.join(os.tmpdir(), 'prewarm-cwdA-'))
    cwdB = await fsp.mkdtemp(path.join(os.tmpdir(), 'prewarm-cwdB-'))
    for (const cwd of [cwdA, cwdB]) {
      await fsp.mkdir(path.join(cwd, 'src'), { recursive: true })
      await fsp.writeFile(path.join(cwd, 'src', 'foo.ts'), fooContent)
      await fsp.writeFile(path.join(cwd, 'src', 'bar.ts'), barContent)
    }
  })

  afterEach(async () => {
    await fsp.rm(cwdA, { recursive: true, force: true })
    await fsp.rm(cwdB, { recursive: true, force: true })
  })

  it('produces byte-identical prefix when called from two distinct cwds with identical files', async () => {
    const body = [
      '## File Pointers',
      '- `src/foo.ts:2-4` — explicit range',
      '- `src/bar.ts:1-3` — explicit range',
      ''
    ].join('\n')

    const prefixA = await composePrewarmPrefix(body, cwdA)
    const prefixB = await composePrewarmPrefix(body, cwdB)

    expect(prefixA).toBe(prefixB)
    expect(prefixA.length).toBeGreaterThan(0)
    expect(prefixA).not.toContain(cwdA)
    expect(prefixA).not.toContain(cwdB)
    expect(prefixA).not.toContain(os.tmpdir())
  })

  it('L2 line-hint path also produces identical output across cwds', async () => {
    const body = [
      '## File Pointers',
      '- `src/foo.ts` — see line 12-15 for context',
      ''
    ].join('\n')

    const prefixA = await composePrewarmPrefix(body, cwdA)
    const prefixB = await composePrewarmPrefix(body, cwdB)

    expect(prefixA).toBe(prefixB)
    expect(prefixA).toContain('line12')
    expect(prefixA).not.toContain(cwdA)
  })

  it('L1 non-existent file path produces identical (empty) output across cwds', async () => {
    const body = '## File Pointers\n- `src/does-not-exist.ts` — new file\n'

    const prefixA = await composePrewarmPrefix(body, cwdA)
    const prefixB = await composePrewarmPrefix(body, cwdB)

    expect(prefixA).toBe(prefixB)
    expect(prefixA).toBe('')
  })

  // Real-worktree empirical check — only runs locally when worktree exists.
  // Goal: confirm the property holds against actual git worktrees, not just synthetic tmpdirs.
  const realCwd = 'C:/dev/choda-deck'
  const realWorktree = 'C:/dev/choda-deck.worktrees/spike-727-cwd'
  const realWorktreeAvailable = fs.existsSync(realWorktree) && fs.existsSync(realCwd)
  it.runIf(realWorktreeAvailable)(
    'real git worktree at same commit produces byte-identical prefix',
    async () => {
      const body = [
        '## File Pointers',
        '- `src/core/executor/prewarm-compose.ts:1-74` — module',
        '- `src/core/executor/prewarm-compose.test.ts:1-100` — tests',
        '- `src/core/executor/queue-claude-spawn.ts:69-78` — caller',
        ''
      ].join('\n')

      const prefixMain = await composePrewarmPrefix(body, realCwd)
      const prefixWt = await composePrewarmPrefix(body, realWorktree)

      expect(prefixMain).toBe(prefixWt)
      expect(prefixMain.length).toBeGreaterThan(0)
      expect(prefixMain).not.toContain(realCwd)
      expect(prefixMain).not.toContain(realWorktree)
      // Log for spike report.
      console.log(`[spike-727] real-worktree prefix length: ${prefixMain.length} bytes`)
    }
  )
})
