import { describe, it, expect, vi } from 'vitest'
import * as taskReject from '../task-reject'
import type { InstrumentedServer } from '../../instrumented-server'
import type {
  ApproveTaskResult,
  RejectTaskResult,
  TaskReviewLifecycleOperations
} from '../../../../core/domain/interfaces/task-review-lifecycle.interface'

interface CapturedTool {
  name: string
  config: { inputSchema: Record<string, { safeParse: (v: unknown) => { success: boolean } }> }
  cb: (args: unknown) => Promise<unknown>
}

function makeFakeServer(): { server: InstrumentedServer; tools: CapturedTool[] } {
  const tools: CapturedTool[] = []
  const server: InstrumentedServer = {
    registerTool: vi.fn(
      (name: string, config: unknown, cb: (args: unknown) => Promise<unknown>) => {
        tools.push({ name, config: config as CapturedTool['config'], cb })
        return { name } as never
      }
    ) as unknown as InstrumentedServer['registerTool'],
    get registeredToolNames(): ReadonlyArray<string> {
      return []
    }
  }
  return { server, tools }
}

function makeSvc(): {
  svc: TaskReviewLifecycleOperations
  rejectCalls: Array<{ taskId: string; reason: string }>
} {
  const rejectCalls: Array<{ taskId: string; reason: string }> = []
  const svc: TaskReviewLifecycleOperations = {
    approveTask: vi.fn((): ApproveTaskResult => {
      throw new Error('should not be called')
    }),
    rejectTask: vi.fn((taskId: string, reason: string): RejectTaskResult => {
      rejectCalls.push({ taskId, reason })
      return { taskId, status: 'IN-PROGRESS', sessionId: 'SESSION-fake-2' }
    })
  }
  return { svc, rejectCalls }
}

function parseText<T>(result: unknown): T {
  const r = result as { content: Array<{ type: string; text: string }> }
  return JSON.parse(r.content[0].text) as T
}

describe('task-reject.register', () => {
  it('registers exactly one tool named task_reject', () => {
    const { server, tools } = makeFakeServer()
    taskReject.register(server, makeSvc().svc)
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('task_reject')
  })

  it('calls svc.rejectTask with taskId + reason', async () => {
    const { server, tools } = makeFakeServer()
    const { svc, rejectCalls } = makeSvc()
    taskReject.register(server, svc)

    await tools[0].cb({ taskId: 'TASK-9', reason: 'tests failing' })
    expect(rejectCalls).toEqual([{ taskId: 'TASK-9', reason: 'tests failing' }])
  })

  it('returns the service result as JSON', async () => {
    const { server, tools } = makeFakeServer()
    const { svc } = makeSvc()
    taskReject.register(server, svc)

    const result = await tools[0].cb({ taskId: 'TASK-10', reason: 'needs rework' })
    const parsed = parseText<RejectTaskResult>(result)
    expect(parsed).toEqual({
      taskId: 'TASK-10',
      status: 'IN-PROGRESS',
      sessionId: 'SESSION-fake-2'
    })
  })

  it('rejects missing taskId via zod schema', () => {
    const { server, tools } = makeFakeServer()
    taskReject.register(server, makeSvc().svc)
    const schema = tools[0].config.inputSchema
    expect(schema.taskId.safeParse(undefined).success).toBe(false)
  })

  it('rejects empty reason via zod schema (min(1))', () => {
    const { server, tools } = makeFakeServer()
    taskReject.register(server, makeSvc().svc)
    const schema = tools[0].config.inputSchema
    expect(schema.reason.safeParse('').success).toBe(false)
    expect(schema.reason.safeParse(undefined).success).toBe(false)
    expect(schema.reason.safeParse('valid reason').success).toBe(true)
  })
})
