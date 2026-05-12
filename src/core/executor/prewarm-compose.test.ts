import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { composePrewarmPrefix, PrewarmPointerResolveError } from './prewarm-compose'

describe('composePrewarmPrefix', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'prewarm-test-'))
    await fsp.mkdir(path.join(tmpDir, 'src'), { recursive: true })
    await fsp.writeFile(
      path.join(tmpDir, 'src', 'foo.ts'),
      Array.from({ length: 25 }, (_, i) => `line${i + 1}`).join('\n') + '\n'
    )
    await fsp.writeFile(
      path.join(tmpDir, 'src', 'bar.ts'),
      'barA\nbarB\nbarC\nbarD\nbarE\nbarF\n'
    )
  })

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true })
  })

  it('parses File Pointers with line range', async () => {
    const body = '## File Pointers\n- `src/foo.ts:2-4` — some description\n'
    const prefix = await composePrewarmPrefix(body, tmpDir)
    expect(prefix).toContain('# Pre-warm')
    expect(prefix).toContain('## src/foo.ts')
    expect(prefix).toContain('line2')
    expect(prefix).toContain('line3')
    expect(prefix).toContain('line4')
    expect(prefix).not.toContain('line5')
  })

  it('L1 — non-existent file pointer accepted as new file, no section emitted', async () => {
    const body = '## File Pointers\n- `src/new-file.ts` — will be created by the task\n'
    const prefix = await composePrewarmPrefix(body, tmpDir)
    expect(prefix).toBe('')
  })

  it('L2 — fills range from line hint in body', async () => {
    const body = '## File Pointers\n- `src/foo.ts` — see line 12-15 for context\n'
    const prefix = await composePrewarmPrefix(body, tmpDir)
    expect(prefix).toContain('# Pre-warm')
    expect(prefix).toContain('line12')
    expect(prefix).toContain('line15')
    expect(prefix).not.toContain('line11')
    expect(prefix).not.toContain('line16')
  })

  it('L3 — fills range from symbol grep in ## Context', async () => {
    const barContent = [
      'import x from "y"',
      'const a = 1',
      'const b = 2',
      'function barFn() {',
      '  return 42',
      '}',
      'export default barFn'
    ].join('\n')
    await fsp.writeFile(path.join(tmpDir, 'src', 'bar.ts'), barContent)

    const body = [
      '## Context',
      '`barFn` does X',
      '',
      '## File Pointers',
      '- `src/bar.ts`',
      ''
    ].join('\n')

    const prefix = await composePrewarmPrefix(body, tmpDir)
    expect(prefix).toContain('# Pre-warm')
    expect(prefix).toContain('function barFn')
    // range = max(1, 4-5)=1 to min(7, 4+5)=7 — entire file
    expect(prefix).toContain('import x from')
    expect(prefix).toContain('export default barFn')
  })

  it('miss — throws PrewarmPointerResolveError when file exists, no range, no hint, no symbol', async () => {
    const body = [
      '## Context',
      'some plain text without any backtick symbols',
      '',
      '## File Pointers',
      '- `src/foo.ts`',
      ''
    ].join('\n')
    await expect(composePrewarmPrefix(body, tmpDir)).rejects.toThrow(PrewarmPointerResolveError)
  })

  it('miss error names the offending file path', async () => {
    const body = '## File Pointers\n- `src/foo.ts`\n'
    const err = await composePrewarmPrefix(body, tmpDir).catch((e) => e)
    expect(err).toBeInstanceOf(PrewarmPointerResolveError)
    expect((err as PrewarmPointerResolveError).errors[0]).toContain('src/foo.ts')
  })

  it('skips missing paths gracefully', async () => {
    const body =
      '## File Pointers\n- `src/foo.ts:1-3` — exists\n- `src/missing.ts:1-5` — does not exist\n'
    const prefix = await composePrewarmPrefix(body, tmpDir)
    expect(prefix).toContain('## src/foo.ts')
    expect(prefix).not.toContain('missing.ts')
    expect(prefix).toContain('line1')
  })

  it('returns empty string when no File Pointers section', async () => {
    const body = '## Context\nSome context.\n\n## Acceptance\nDo the thing.\n'
    const prefix = await composePrewarmPrefix(body, tmpDir)
    expect(prefix).toBe('')
  })

  it('prefix size is sane for ~5 file pointers (<1k tokens)', async () => {
    const body = [
      '## File Pointers',
      '- `src/foo.ts:1-5` — file A',
      '- `src/bar.ts:1-5` — file B',
      '- `src/foo.ts:6-10` — file C',
      '- `src/bar.ts:2-5` — file D',
      '- `src/foo.ts:2-5` — file E',
      ''
    ].join('\n')
    const prefix = await composePrewarmPrefix(body, tmpDir)
    const tokenEstimate = prefix.length / 4
    expect(tokenEstimate).toBeLessThan(1000)
  })
})
