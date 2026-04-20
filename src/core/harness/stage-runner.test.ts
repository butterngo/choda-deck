import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import {
  runClaudeStage,
  StageBudgetExceededError,
  StageInvalidOutputError,
  StageNonZeroExitError,
  StageTimeoutError
} from './stage-runner'

interface FakeChildOpts {
  stdout: string
  stderr?: string
  exitCode?: number
  closeDelayMs?: number
  neverClose?: boolean
}

function fakeChild(opts: FakeChildOpts): EventEmitter & {
  stdout: PassThrough
  stderr: PassThrough
  stdin: PassThrough
  killed: boolean
  exitCode: number | null
  kill: (sig?: string) => void
} {
  const emitter = new EventEmitter() as EventEmitter & {
    stdout: PassThrough
    stderr: PassThrough
    stdin: PassThrough
    killed: boolean
    exitCode: number | null
    kill: (sig?: string) => void
  }
  emitter.stdout = new PassThrough()
  emitter.stderr = new PassThrough()
  emitter.stdin = new PassThrough()
  emitter.killed = false
  emitter.exitCode = null
  emitter.kill = vi.fn((_sig?: string) => {
    emitter.killed = true
    setImmediate(() => {
      if (emitter.exitCode !== null) return
      emitter.exitCode = 143
      emitter.emit('close', emitter.exitCode, _sig ?? 'SIGTERM')
    })
  })

  setImmediate(() => {
    emitter.stdout.write(opts.stdout)
    emitter.stdout.end()
    if (opts.stderr) {
      emitter.stderr.write(opts.stderr)
    }
    emitter.stderr.end()

    const close = (): void => {
      emitter.exitCode = opts.exitCode ?? 0
      emitter.emit('close', emitter.exitCode, null)
    }
    if (opts.neverClose) return
    if (opts.closeDelayMs) setTimeout(close, opts.closeDelayMs)
    else setImmediate(close)
  })

  return emitter
}

function baseOpts(overrides: Partial<Parameters<typeof runClaudeStage>[0]> = {}): Parameters<
  typeof runClaudeStage
>[0] {
  return {
    workspacePath: '/tmp/ws',
    prompt: 'do it',
    model: 'claude-opus-4-7',
    tools: ['Read', 'Grep', 'Glob'],
    maxBudgetUsd: 0.25,
    timeoutMs: 5_000,
    claudeCmd: 'claude',
    ...overrides
  }
}

describe('runClaudeStage', () => {
  it('returns parsed JSON on successful exit', async () => {
    const stdoutJson = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: '{"files":[]}',
      total_cost_usd: 0.05,
      duration_ms: 1200
    })
    const spawnFn = vi.fn(() => fakeChild({ stdout: stdoutJson, exitCode: 0 })) as never

    const res = await runClaudeStage(baseOpts({ spawnFn }))

    expect(res.parsed.result).toBe('{"files":[]}')
    expect(res.totalCostUsd).toBe(0.05)
    expect(res.exitCode).toBe(0)
  })

  it('passes prompt to stdin', async () => {
    const child = fakeChild({
      stdout: JSON.stringify({ result: '{}', total_cost_usd: 0, duration_ms: 1 }),
      exitCode: 0
    })
    const writeSpy = vi.spyOn(child.stdin, 'write')
    const endSpy = vi.spyOn(child.stdin, 'end')
    const spawnFn = vi.fn(() => child) as never

    await runClaudeStage(baseOpts({ spawnFn, prompt: 'hello planner' }))

    expect(writeSpy).toHaveBeenCalledWith('hello planner')
    expect(endSpy).toHaveBeenCalled()
  })

  it('includes required hermetic flags in spawn args (POSIX path)', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux' })
    try {
      const child = fakeChild({
        stdout: JSON.stringify({ result: '{}', total_cost_usd: 0 }),
        exitCode: 0
      })
      const spawnFn = vi.fn(() => child) as never

      await runClaudeStage(
        baseOpts({
          spawnFn,
          tools: ['Read', 'Grep'],
          allowedTools: ['Bash(git *)']
        })
      )

      const call = (spawnFn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]
      const args = call[1] as string[]
      expect(args).toContain('-p')
      expect(args).toContain('--model')
      expect(args).toContain('--output-format')
      expect(args).toContain('json')
      expect(args).toContain('--no-session-persistence')
      expect(args).toContain('--setting-sources')
      expect(args).toContain('user')
      expect(args).toContain('--tools')
      expect(args).toContain('Read,Grep')
      expect(args).toContain('--allowed-tools')
      expect(args).toContain('Bash(git *)')
      expect(args).toContain('--max-budget-usd')
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    }
  })

  it('throws StageNonZeroExitError on non-zero exit', async () => {
    const spawnFn = vi.fn(() =>
      fakeChild({
        stdout: JSON.stringify({ result: 'bang', total_cost_usd: 0 }),
        stderr: 'boom',
        exitCode: 1
      })
    ) as never

    await expect(runClaudeStage(baseOpts({ spawnFn }))).rejects.toBeInstanceOf(
      StageNonZeroExitError
    )
  })

  it('throws StageNonZeroExitError when parsed.is_error is true', async () => {
    const spawnFn = vi.fn(() =>
      fakeChild({
        stdout: JSON.stringify({
          result: 'oops',
          is_error: true,
          total_cost_usd: 0
        }),
        exitCode: 0
      })
    ) as never

    await expect(runClaudeStage(baseOpts({ spawnFn }))).rejects.toBeInstanceOf(
      StageNonZeroExitError
    )
  })

  it('throws StageInvalidOutputError when stdout is not JSON', async () => {
    const spawnFn = vi.fn(() => fakeChild({ stdout: 'not json', exitCode: 0 })) as never

    await expect(runClaudeStage(baseOpts({ spawnFn }))).rejects.toBeInstanceOf(
      StageInvalidOutputError
    )
  })

  it('throws StageBudgetExceededError when total_cost_usd > 2.5x cap', async () => {
    const spawnFn = vi.fn(() =>
      fakeChild({
        stdout: JSON.stringify({
          result: '{}',
          total_cost_usd: 1.0 // cap is 0.25; 2.5x = 0.625; actual 1.0 > 0.625
        }),
        exitCode: 0
      })
    ) as never

    await expect(runClaudeStage(baseOpts({ spawnFn }))).rejects.toBeInstanceOf(
      StageBudgetExceededError
    )
  })

  it('throws StageTimeoutError when process does not close within timeoutMs', async () => {
    const spawnFn = vi.fn(() =>
      fakeChild({ stdout: '', exitCode: 0, neverClose: true })
    ) as never

    await expect(
      runClaudeStage(baseOpts({ spawnFn, timeoutMs: 50 }))
    ).rejects.toBeInstanceOf(StageTimeoutError)
  })
})
