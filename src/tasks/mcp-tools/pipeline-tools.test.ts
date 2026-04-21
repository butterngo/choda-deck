import { describe, it, expect, vi, beforeEach } from 'vitest'
import { register, type PipelineToolsDeps } from './pipeline-tools'
import {
  HarnessError,
  InteractiveConversationBlockingError,
  PipelineSessionNotFoundError,
  TaskNotFoundError
} from '../../core/harness/errors'
import type { PipelineState } from '../../core/harness/pipeline-state'
import type { HarnessRunner } from '../../core/harness/harness-runner'
import type { PlannerStageDeps, runPlannerStage } from '../../core/harness/planner-stage'
import type {
  GeneratorStageDeps,
  runGeneratorStage
} from '../../core/harness/generator-stage'

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: 'text'; text: string }>
}>

class FakeServer {
  handlers = new Map<string, ToolHandler>()
  registerTool(
    name: string,
    _config: unknown,
    handler: ToolHandler
  ): void {
    this.handlers.set(name, handler)
  }
}

function parseBody(res: { content: Array<{ text: string }> }): unknown {
  return JSON.parse(res.content[0].text)
}

const sampleState = (overrides: Partial<PipelineState> = {}): PipelineState => ({
  sessionId: 'SESSION-1',
  projectId: 'proj-1',
  taskId: 'TASK-1',
  stage: 'plan',
  stageStatus: 'running',
  currentIteration: 0,
  needsEvaluator: false,
  startedAt: '2026-01-01T00:00:00Z',
  ...overrides
})

interface Harness {
  startPipeline: ReturnType<typeof vi.fn>
  approveStage: ReturnType<typeof vi.fn>
  rejectStage: ReturnType<typeof vi.fn>
  abort: ReturnType<typeof vi.fn>
}

function buildHarnessMock(): Harness {
  return {
    startPipeline: vi.fn(),
    approveStage: vi.fn(),
    rejectStage: vi.fn(),
    abort: vi.fn()
  }
}

function buildDeps(harness: Harness): PipelineToolsDeps {
  const plannerDeps = {} as PlannerStageDeps
  const generatorDeps = {} as GeneratorStageDeps
  return {
    getHarnessRunner: () => harness as unknown as HarnessRunner,
    getPlannerStageDeps: () => plannerDeps,
    getGeneratorStageDeps: () => generatorDeps
  }
}

function registerWithMock(
  harness: Harness,
  runPlanner: typeof runPlannerStage,
  runGenerator?: typeof runGeneratorStage
): FakeServer {
  const server = new FakeServer()
  register(
    server as unknown as Parameters<typeof register>[0],
    buildDeps(harness),
    {
      artifactsConfig: { dataDir: '/tmp/artifacts' },
      runPlanner,
      runGenerator: runGenerator ?? (vi.fn().mockResolvedValue({}) as unknown as typeof runGeneratorStage)
    }
  )
  return server
}

describe('pipeline-tools', () => {
  let harness: Harness
  let runPlanner: ReturnType<typeof vi.fn>

  beforeEach(() => {
    harness = buildHarnessMock()
    runPlanner = vi.fn().mockResolvedValue({
      artifactPath: '/tmp/plan.json',
      plan: {},
      totalCostUsd: 0,
      durationMs: 100
    })
  })

  it('registers all 4 pipeline tools', () => {
    const server = registerWithMock(harness, runPlanner as unknown as typeof runPlannerStage)
    expect([...server.handlers.keys()].sort()).toEqual([
      'pipeline_abort',
      'pipeline_approve',
      'pipeline_reject',
      'pipeline_start'
    ])
  })

  describe('pipeline_start', () => {
    it('calls startPipeline + fires planner + returns state shape', async () => {
      harness.startPipeline.mockReturnValue(sampleState())
      const server = registerWithMock(harness, runPlanner as unknown as typeof runPlannerStage)

      const res = await server.handlers.get('pipeline_start')!({
        taskId: 'TASK-1',
        evaluator: 'auto'
      })

      expect(harness.startPipeline).toHaveBeenCalledWith('TASK-1', { evaluator: 'auto' })
      expect(runPlanner).toHaveBeenCalledTimes(1)
      expect(runPlanner.mock.calls[0][1]).toBe('SESSION-1')
      expect(parseBody(res)).toEqual({
        sessionId: 'SESSION-1',
        stage: 'plan',
        stage_status: 'running',
        iteration: 0,
        needs_evaluator: false
      })
    })

    it('returns structured R3 error payload when interactive conversation blocks', async () => {
      harness.startPipeline.mockImplementation(() => {
        throw new InteractiveConversationBlockingError({
          owner_type: 'interactive',
          owner_session_id: 'SESSION-OLD',
          owner_task_id: 'TASK-OLD',
          started_at: '2026-01-01T00:00:00Z'
        })
      })
      const server = registerWithMock(harness, runPlanner as unknown as typeof runPlannerStage)

      const res = await server.handlers.get('pipeline_start')!({
        taskId: 'TASK-1',
        evaluator: 'off'
      })

      const body = parseBody(res) as {
        error: { code: string; message_vi: string; payload: Record<string, unknown> }
      }
      expect(body.error.code).toBe('INTERACTIVE_CONV_BLOCKING')
      expect(body.error.message_vi).toContain('hội thoại')
      expect(body.error.payload).toEqual({
        owner_type: 'interactive',
        owner_session_id: 'SESSION-OLD',
        owner_task_id: 'TASK-OLD',
        started_at: '2026-01-01T00:00:00Z'
      })
      expect(runPlanner).not.toHaveBeenCalled()
    })

    it('formats generic HarnessError as { code, message }', async () => {
      harness.startPipeline.mockImplementation(() => {
        throw new TaskNotFoundError('TASK-404')
      })
      const server = registerWithMock(harness, runPlanner as unknown as typeof runPlannerStage)

      const res = await server.handlers.get('pipeline_start')!({
        taskId: 'TASK-404',
        evaluator: 'off'
      })

      const body = parseBody(res) as { error: { code: string; message: string } }
      expect(body.error.code).toBe('TASK_NOT_FOUND')
      expect(body.error.message).toContain('TASK-404')
    })

    it('rethrows non-harness errors', async () => {
      harness.startPipeline.mockImplementation(() => {
        throw new Error('db disk full')
      })
      const server = registerWithMock(harness, runPlanner as unknown as typeof runPlannerStage)

      await expect(
        server.handlers.get('pipeline_start')!({ taskId: 'TASK-1', evaluator: 'off' })
      ).rejects.toThrow('db disk full')
    })
  })

  describe('pipeline_approve', () => {
    it('calls approveStage + fires generator when new stage is generate + returns state', async () => {
      harness.approveStage.mockReturnValue(
        sampleState({ stage: 'generate', stageStatus: 'running', currentIteration: 0 })
      )
      const runGenerator = vi.fn().mockResolvedValue({})
      const server = registerWithMock(
        harness,
        runPlanner as unknown as typeof runPlannerStage,
        runGenerator as unknown as typeof runGeneratorStage
      )

      const res = await server.handlers.get('pipeline_approve')!({ sessionId: 'SESSION-1' })

      expect(harness.approveStage).toHaveBeenCalledWith('SESSION-1')
      expect(runPlanner).not.toHaveBeenCalled()
      expect(runGenerator).toHaveBeenCalledTimes(1)
      expect(runGenerator.mock.calls[0][1]).toBe('SESSION-1')
      expect(runGenerator.mock.calls[0][2]).toEqual({ rejectionFeedback: null })
      expect(parseBody(res)).toMatchObject({
        sessionId: 'SESSION-1',
        stage: 'generate',
        stage_status: 'running'
      })
    })

    it('does not fire any runner when new stage is done', async () => {
      harness.approveStage.mockReturnValue(
        sampleState({ stage: 'done', stageStatus: null, currentIteration: 0 })
      )
      const runGenerator = vi.fn()
      const server = registerWithMock(
        harness,
        runPlanner as unknown as typeof runPlannerStage,
        runGenerator as unknown as typeof runGeneratorStage
      )

      await server.handlers.get('pipeline_approve')!({ sessionId: 'SESSION-1' })
      expect(runPlanner).not.toHaveBeenCalled()
      expect(runGenerator).not.toHaveBeenCalled()
    })

    it('maps PipelineSessionNotFoundError to error payload', async () => {
      harness.approveStage.mockImplementation(() => {
        throw new PipelineSessionNotFoundError('SESSION-GONE')
      })
      const server = registerWithMock(harness, runPlanner as unknown as typeof runPlannerStage)

      const res = await server.handlers.get('pipeline_approve')!({ sessionId: 'SESSION-GONE' })
      const body = parseBody(res) as { error: { code: string } }
      expect(body.error.code).toBe('PIPELINE_SESSION_NOT_FOUND')
    })
  })

  describe('pipeline_reject', () => {
    it('calls rejectStage with feedback + fires planner re-run on plan stage', async () => {
      harness.rejectStage.mockReturnValue(
        sampleState({ stage: 'plan', stageStatus: 'rejected', currentIteration: 1 })
      )
      const server = registerWithMock(harness, runPlanner as unknown as typeof runPlannerStage)

      const res = await server.handlers.get('pipeline_reject')!({
        sessionId: 'SESSION-1',
        feedback: 'missing edge case'
      })

      expect(harness.rejectStage).toHaveBeenCalledWith('SESSION-1', 'missing edge case')
      expect(runPlanner).toHaveBeenCalledTimes(1)
      expect(runPlanner.mock.calls[0][1]).toBe('SESSION-1')
      expect(parseBody(res)).toMatchObject({
        sessionId: 'SESSION-1',
        stage_status: 'rejected',
        iteration: 1
      })
    })

    it('fires generator re-run with rejectionFeedback when rejecting on generate stage', async () => {
      harness.rejectStage.mockReturnValue(
        sampleState({ stage: 'generate', stageStatus: 'rejected', currentIteration: 1 })
      )
      const runGenerator = vi.fn().mockResolvedValue({})
      const server = registerWithMock(
        harness,
        runPlanner as unknown as typeof runPlannerStage,
        runGenerator as unknown as typeof runGeneratorStage
      )

      await server.handlers.get('pipeline_reject')!({
        sessionId: 'SESSION-1',
        feedback: 'plan step 2 wrong'
      })

      expect(runPlanner).not.toHaveBeenCalled()
      expect(runGenerator).toHaveBeenCalledTimes(1)
      expect(runGenerator.mock.calls[0][1]).toBe('SESSION-1')
      expect(runGenerator.mock.calls[0][2]).toEqual({ rejectionFeedback: 'plan step 2 wrong' })
    })
  })

  describe('pipeline_abort', () => {
    it('calls abort + returns aborted state', async () => {
      harness.abort.mockReturnValue(
        sampleState({ stage: 'aborted', stageStatus: null })
      )
      const server = registerWithMock(harness, runPlanner as unknown as typeof runPlannerStage)

      const res = await server.handlers.get('pipeline_abort')!({ sessionId: 'SESSION-1' })

      expect(harness.abort).toHaveBeenCalledWith('SESSION-1')
      expect(runPlanner).not.toHaveBeenCalled()
      expect(parseBody(res)).toMatchObject({
        sessionId: 'SESSION-1',
        stage: 'aborted',
        stage_status: null
      })
    })
  })

  it('swallows planner-async errors (runPlannerStage rejected)', async () => {
    // runPlannerStage calls failStage internally; tool handler should not await or throw.
    harness.startPipeline.mockReturnValue(sampleState())
    const failingPlanner = vi
      .fn()
      .mockRejectedValue(new HarnessError('PLANNER_FAIL', 'boom'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const server = registerWithMock(
      harness,
      failingPlanner as unknown as typeof runPlannerStage
    )
    await expect(
      server.handlers.get('pipeline_start')!({ taskId: 'TASK-1', evaluator: 'off' })
    ).resolves.toBeDefined()

    await new Promise((r) => setImmediate(r))
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })
})
