import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { runMermaidCheck, type MermaidCheckIo } from './mermaid-command'
import { checkMermaid } from '../companion/mermaid-check'

// TASK-2596 — `choda-deck mermaid check`. Temp files, real mermaid parse.

let tmp: string

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mermaid-cmd-'))
  // Warm the parser in setup: a cold mermaid import can take tens of seconds on
  // a loaded machine, and the first test would time out on something it does
  // not assert (the same reason mermaid-check.test.ts warms it).
  await checkMermaid('sequenceDiagram\n  A->>B: warm')
}, 120_000)

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function write(name: string, body: string): string {
  const p = path.join(tmp, name)
  fs.writeFileSync(p, body)
  return p
}

async function run(target: string, stdin = ''): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const io: MermaidCheckIo = {
    out: (s) => (out += s),
    err: (s) => (err += s),
    readStdin: async () => stdin
  }
  const code = await runMermaidCheck(target, io)
  return { code, out, err }
}

const VALID_SEQUENCE = ['```mermaid', 'sequenceDiagram', '  A->>B: hi', '```'].join('\n')

// Line numbers in the file matter to the assertion, so the layout is explicit:
// the second fence's body starts on line 11, and its bad label is on line 13.
const TWO_FENCES = [
  '# Doc', //                                   1
  '', //                                        2
  '```mermaid', //                              3
  'sequenceDiagram', //                         4
  '  A->>B: hi', //                             5
  '```', //                                     6
  '', //                                        7
  'Some prose.', //                             8
  '', //                                        9
  '```mermaid', //                              10
  'flowchart TB', //                            11
  '    subgraph Auth["Auth / Credentials"]', // 12
  '        SS[SecretStore\\n{{secrets.KEY}}]', // 13
  '        BS[BearerStatic]', //                14
  '    end', //                                 15
  '```', //                                     16
  ''
].join('\n')

describe('mermaid check (TASK-2596)', () => {
  it('AC-0: one valid sequenceDiagram fence prints "ok: 1 fence(s)" and exits 0', async () => {
    const r = await run(write('valid.md', `# T\n\n${VALID_SEQUENCE}\n`))
    expect(r.out).toBe('ok: 1 fence(s)\n')
    expect(r.code).toBe(0)
  })

  it('AC-1: a second fence with an unquoted {{ in a node label exits 1', async () => {
    const r = await run(write('bad.md', TWO_FENCES))
    expect(r.code).toBe(1)
  })

  it('AC-2: the failure line names fence 2 and the file line of the bad label', async () => {
    const r = await run(write('bad2.md', TWO_FENCES))
    const lines = r.err.trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^fence 2, line 13: /)
  })

  it('AC-3: a file with no fence prints "ok: 0 fence(s)" and exits 0', async () => {
    const r = await run(write('none.md', '# Nothing to draw\n\nJust prose.\n'))
    expect(r.out).toBe('ok: 0 fence(s)\n')
    expect(r.code).toBe(0)
  })

  it('AC-4: a missing path exits 2 and says so', async () => {
    const r = await run(path.join(tmp, 'does-not-exist.md'))
    expect(r.code).toBe(2)
    expect(r.err).toContain('file not found')
  })

  it('reads stdin for "-"', async () => {
    const r = await run('-', `${VALID_SEQUENCE}\n`)
    expect(r.code).toBe(0)
    expect(r.out).toBe('ok: 1 fence(s)\n')
  })

  it('CRLF files report the same file line', async () => {
    const r = await run(write('crlf.md', TWO_FENCES.replace(/\n/g, '\r\n')))
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/^fence 2, line 13: /)
  })
})
