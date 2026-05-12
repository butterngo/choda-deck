import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpawnClaudeInput } from '../domain/lifecycle/queue-lifecycle-service'
import { createQueueClaudeSpawner } from './queue-claude-spawn'

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

  it('stdin equals taskBody when prewarm is false', async () => {
    const spawner = createQueueClaudeSpawner()
    await spawner({ ...baseInput, prewarm: false })
    expect(capturedStdin).toBe(baseInput.taskBody)
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
