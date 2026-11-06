import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawnSync } from 'child_process'
import { hookOutput } from '../rules-warn.mjs'

// TASK-3130 — the SessionStart hook warns, never blocks. The CLI is stubbed by a
// tiny script so the hook's own behaviour is what is under test.

const hook = path.resolve(__dirname, '..', 'rules-warn.mjs')
let tmp: string

function stubCli(name: string, body: string): string {
  const file = path.join(tmp, `${name}.cjs`)
  fs.writeFileSync(file, body)
  return file
}

function runHook(cli: string, input: string) {
  return spawnSync(process.execPath, [hook, '--cli', cli], { input, encoding: 'utf8' })
}

const blocked = {
  projectId: 'capabilities',
  week: '2026-W45',
  verdict: 'blocked',
  reasons: [{ rule: 1, message: "rule 1: capabilities is not one of 2026-W45's projects (tms)" }],
  warnings: []
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-warn-'))
})
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('rules-warn hook', () => {
  it('an unpicked project prints additionalContext naming rule 1, and exits 0', () => {
    const cli = stubCli(
      'blocked',
      `process.stdout.write(${JSON.stringify(JSON.stringify(blocked))}); process.exit(3)`
    )
    const res = runHook(cli, JSON.stringify({ cwd: 'C:/dev/test/capabilities' }))
    expect(res.status).toBe(0)
    const out = JSON.parse(res.stdout)
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart')
    expect(out.hookSpecificOutput.additionalContext).toContain('rule 1')
  })

  it('a picked project with nothing waiting prints nothing, and exits 0', () => {
    const pass = { ...blocked, projectId: 'tms', verdict: 'pass', reasons: [] }
    const cli = stubCli('pass', `process.stdout.write(${JSON.stringify(JSON.stringify(pass))})`)
    const res = runHook(cli, JSON.stringify({ cwd: 'C:/dev/test/tms' }))
    expect(res.status).toBe(0)
    expect(res.stdout).toBe('')
  })

  it('exits 0 with no output when the CLI crashes, is missing, or stdin is garbage', () => {
    const crash = stubCli('crash', 'throw new Error("boom")')
    expect(runHook(crash, JSON.stringify({ cwd: 'C:/x' }))).toMatchObject({ status: 0, stdout: '' })
    const missing = path.join(tmp, 'does-not-exist.cjs')
    expect(runHook(missing, JSON.stringify({ cwd: 'C:/x' }))).toMatchObject({
      status: 0,
      stdout: ''
    })
    expect(runHook(crash, 'not json')).toMatchObject({ status: 0, stdout: '' })
  })

  it('hookOutput is empty for a pass or a null verdict', () => {
    expect(hookOutput(null)).toBe('')
    expect(hookOutput({ ...blocked, verdict: 'pass', reasons: [] })).toBe('')
  })
})
