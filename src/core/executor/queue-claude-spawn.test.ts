import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpawnClaudeInput } from '../domain/lifecycle/queue-lifecycle-service'
import {
  createQueueClaudeSpawner,
  createQueueRuntime,
  QUEUE_AC_FINAL_VERIFY_NUDGE
} from './queue-claude-spawn'

vi.mock('./coder', () => ({
  runProcess: vi.fn(),
  runShell: vi.fn()
}))

vi.mock('./prewarm-compose', async () => {
  const actual = await vi.importActual<typeof import('./prewarm-compose')>('./prewarm-compose')
  return {
    ...actual,
    composePrewarmPrefix: vi.fn().mockResolvedValue('# Pre-warm\n\n## src/foo.ts\nfake content')
  }
})

const baseInput: SpawnClaudeInput = {
  taskBody: 'do the thing',
  cwd: '/fake/cwd',
  model: 'claude-sonnet-4-6',
  maxBudgetUsd: 0.95,
  queueMcpEmptyPath: '/fake/mcp-empty.json',
  claudeBin: 'claude'
}

const okResponse = JSON.stringify({
  is_error: false,
  total_cost_usd: 0.1,
  num_turns: 5,
  result: 'done'
})

describe('createQueueClaudeSpawner — prewarm stdin', () => {
  let capturedStdin: string | undefined

  beforeEach(async () => {
    const { runProcess } = await import('./coder')
    vi.mocked(runProcess).mockImplementation(async (_bin, _args, opts) => {
      capturedStdin = (opts as { stdin?: string }).stdin
      return { exitCode: 0, stdout: okResponse, stderr: '' }
    })
    capturedStdin = undefined
  })

  it('prepends pre-warm prefix to stdin when prewarm is on (default)', async () => {
    const spawner = createQueueClaudeSpawner()
    await spawner(baseInput)
    expect(capturedStdin).toMatch(/^# Pre-warm/)
    expect(capturedStdin).toContain(baseInput.taskBody)
  })

  it('stdin starts with taskBody when prewarm is false', async () => {
    const spawner = createQueueClaudeSpawner()
    await spawner({ ...baseInput, prewarm: false })
    expect(capturedStdin?.startsWith(baseInput.taskBody)).toBe(true)
  })

  it('appends AC final-verify nudge to stdin (TASK-732, ADR-023 Fix 1)', async () => {
    const spawner = createQueueClaudeSpawner()
    await spawner(baseInput)
    expect(capturedStdin).toContain('re-run every command in ## Acceptance ONCE MORE')
    expect(capturedStdin?.endsWith(QUEUE_AC_FINAL_VERIFY_NUDGE)).toBe(true)
  })

  it('appends nudge even when prewarm is off', async () => {
    const spawner = createQueueClaudeSpawner()
    await spawner({ ...baseInput, prewarm: false })
    expect(capturedStdin).toContain(QUEUE_AC_FINAL_VERIFY_NUDGE)
    expect(capturedStdin?.startsWith(baseInput.taskBody)).toBe(true)
  })
})

describe('createQueueRuntime — resolveRef (TASK-736 Windows caret regression)', () => {
  it('does not pass a `^` caret in any arg (cmd.exe escape strips it on win32 shell:true)', async () => {
    const { runProcess } = await import('./coder')
    const spy = vi.mocked(runProcess)
    spy.mockClear()
    spy.mockResolvedValueOnce({ exitCode: 0, stdout: 'abc123\n', stderr: '' })

    const rt = createQueueRuntime({ artifactsDir: '/fake/artifacts', queueMcpEmptyPath: '/fake/mcp-empty.json' })
    const sha = await rt.resolveRef('/fake/repo', 'main')

    expect(sha).toBe('abc123')
    expect(spy).toHaveBeenCalledTimes(1)
    const [bin, args] = spy.mock.calls[0]
    expect(bin).toBe('git')
    for (const a of args) {
      expect(a).not.toContain('^')
    }
  })

  it('returns null when git exits non-zero', async () => {
    const { runProcess } = await import('./coder')
    const spy = vi.mocked(runProcess)
    spy.mockClear()
    spy.mockResolvedValueOnce({ exitCode: 128, stdout: '', stderr: 'unknown revision' })

    const rt = createQueueRuntime({ artifactsDir: '/fake/artifacts', queueMcpEmptyPath: '/fake/mcp-empty.json' })
    const sha = await rt.resolveRef('/fake/repo', 'doesnt-exist')

    expect(sha).toBeNull()
  })
})

describe('createQueueClaudeSpawner — prewarm rejection', () => {
  it('returns isError with prewarm-rejected prefix, runProcess not called', async () => {
    const { composePrewarmPrefix, PrewarmPointerResolveError } = await import('./prewarm-compose')
    vi.mocked(composePrewarmPrefix).mockRejectedValueOnce(
      new PrewarmPointerResolveError(['src/foo.ts: no range, no hint, no symbol (L3 last attempted)'])
    )

    const { runProcess } = await import('./coder')
    const runProcessSpy = vi.mocked(runProcess)
    runProcessSpy.mockClear()

    const spawner = createQueueClaudeSpawner()
    const result = await spawner(baseInput)

    expect(result.isError).toBe(true)
    expect(result.resultText).toMatch(/^prewarm-rejected:/)
    expect(result.resultText).toContain('src/foo.ts')
    expect(result.totalCostUsd).toBe(0)
    expect(runProcessSpy).not.toHaveBeenCalled()
  })
})
