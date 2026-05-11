import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { composePrewarmPrefix } from './prewarm-compose'

describe('composePrewarmPrefix', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'prewarm-test-'))
    await fsp.mkdir(path.join(tmpDir, 'src'), { recursive: true })
    await fsp.writeFile(
      path.join(tmpDir, 'src', 'foo.ts'),
      'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n'
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

  it('parses File Pointers without line range (uses first 5 lines)', async () => {
    const body = '## File Pointers\n- `src/foo.ts` — no range\n'
    const prefix = await composePrewarmPrefix(body, tmpDir)
    expect(prefix).toContain('line1')
    expect(prefix).toContain('line5')
    expect(prefix).not.toContain('line6')
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
