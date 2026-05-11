import { describe, expect, it } from 'vitest'
import { runProcess, runShell } from './coder'

const cwd = process.cwd()
const timeoutMs = 10_000

describe('runProcess', () => {
  it('spawns node with positional args and captures stdout', async () => {
    const r = await runProcess('node', ['-e', "process.stdout.write('ok')"], { cwd, timeoutMs })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('ok')
  })
})

describe('runShell', () => {
  it('executes a shell conjunction and captures stdout from both sides', async () => {
    const cmd =
      "node -e \"process.stdout.write('a')\" && node -e \"process.stdout.write('b')\""
    const r = await runShell(cmd, { cwd, timeoutMs })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('a')
    expect(r.stdout).toContain('b')
  })
})
