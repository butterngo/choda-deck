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

describe('createQueueClaudeSpawner — non-zero exit preserves envelope cost + reason (TASK-791)', () => {
  it('parses stdout envelope when exit !=0: keeps cost, joins errors[] into resultText', async () => {
    const budgetEnvelope = JSON.stringify({
      type: 'result',
      subtype: 'error_max_budget_usd',
      is_error: true,
      num_turns: 22,
      total_cost_usd: 1.4289005499999996,
      errors: ['Reached maximum budget ($1.42)']
    })
    const { runProcess } = await import('./coder')
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: 1,
      stdout: budgetEnvelope,
      stderr: ''
    })

    const spawner = createQueueClaudeSpawner()
    const result = await spawner({ ...baseInput, prewarm: false })

    expect(result.isError).toBe(true)
    expect(result.totalCostUsd).toBeCloseTo(1.4289, 4)
    expect(result.numTurns).toBe(22)
    expect(result.resultText).toContain('claude -p exited 1:')
    expect(result.resultText).toContain('Reached maximum budget')
    expect(result.rawJson).toBe(budgetEnvelope)
  })

  it('prefers envelope.result string over errors[] when both present and exit !=0', async () => {
    const envelope = JSON.stringify({
      is_error: true,
      total_cost_usd: 0.5,
      num_turns: 3,
      result: 'prompt rejected by policy',
      errors: ['secondary noise']
    })
    const { runProcess } = await import('./coder')
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: 2,
      stdout: envelope,
      stderr: ''
    })

    const spawner = createQueueClaudeSpawner()
    const result = await spawner({ ...baseInput, prewarm: false })

    expect(result.isError).toBe(true)
    expect(result.totalCostUsd).toBe(0.5)
    expect(result.resultText).toContain('claude -p exited 2:')
    expect(result.resultText).toContain('prompt rejected by policy')
    expect(result.resultText).not.toContain('secondary noise')
  })

  it('falls back to stderr message when exit !=0 and stdout is not valid JSON', async () => {
    const { runProcess } = await import('./coder')
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: 1,
      stdout: 'spawn ENOENT — claude binary missing',
      stderr: 'claude: command not found'
    })

    const spawner = createQueueClaudeSpawner()
    const result = await spawner({ ...baseInput, prewarm: false })

    expect(result.isError).toBe(true)
    expect(result.totalCostUsd).toBe(0)
    expect(result.numTurns).toBe(0)
    expect(result.resultText).toBe('claude -p exited 1: claude: command not found')
  })

  it('falls back when exit !=0 and stdout is empty', async () => {
    const { runProcess } = await import('./coder')
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: 137,
      stdout: '',
      stderr: 'killed by SIGKILL'
    })

    const spawner = createQueueClaudeSpawner()
    const result = await spawner({ ...baseInput, prewarm: false })

    expect(result.isError).toBe(true)
    expect(result.totalCostUsd).toBe(0)
    expect(result.numTurns).toBe(0)
    expect(result.resultText).toBe('claude -p exited 137: killed by SIGKILL')
  })

  it('regression: exit 0 + valid envelope preserves existing happy-path behavior', async () => {
    const envelope = JSON.stringify({
      is_error: false,
      total_cost_usd: 0.25,
      num_turns: 8,
      result: 'task complete'
    })
    const { runProcess } = await import('./coder')
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: 0,
      stdout: envelope,
      stderr: ''
    })

    const spawner = createQueueClaudeSpawner()
    const result = await spawner({ ...baseInput, prewarm: false })

    expect(result.isError).toBe(false)
    expect(result.totalCostUsd).toBe(0.25)
    expect(result.numTurns).toBe(8)
    expect(result.resultText).toBe('task complete')
    expect(result.resultText).not.toContain('claude -p exited')
  })
})
