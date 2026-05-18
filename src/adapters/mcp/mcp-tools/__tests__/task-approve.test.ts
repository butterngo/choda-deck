import { describe, it, expect, vi } from 'vitest'
import * as taskApprove from '../task-approve'
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
  approveCalls: Array<{ taskId: string; note: string | undefined }>
} {
  const approveCalls: Array<{ taskId: string; note: string | undefined }> = []
  const svc: TaskReviewLifecycleOperations = {
    approveTask: vi.fn((taskId: string, note?: string): ApproveTaskResult => {
      approveCalls.push({ taskId, note })
      return { taskId, status: 'DONE', sessionId: 'SESSION-fake-1' }
    }),
    rejectTask: vi.fn((): RejectTaskResult => {
      throw new Error('should not be called')
    })
  }
  return { svc, approveCalls }
}

function parseText<T>(result: unknown): T {
  const r = result as { content: Array<{ type: string; text: string }> }
  return JSON.parse(r.content[0].text) as T
}

describe('task-approve.register', () => {
  it('registers exactly one tool named task_approve', () => {
    const { server, tools } = makeFakeServer()
    taskApprove.register(server, makeSvc().svc)
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('task_approve')
  })

  it('calls svc.approveTask with taskId + optional note', async () => {
    const { server, tools } = makeFakeServer()
    const { svc, approveCalls } = makeSvc()
    taskApprove.register(server, svc)

    await tools[0].cb({ taskId: 'TASK-1', note: 'looks good' })
    expect(approveCalls).toEqual([{ taskId: 'TASK-1', note: 'looks good' }])
  })

  it('omits note when not provided', async () => {
    const { server, tools } = makeFakeServer()
    const { svc, approveCalls } = makeSvc()
    taskApprove.register(server, svc)

    await tools[0].cb({ taskId: 'TASK-2' })
    expect(approveCalls).toEqual([{ taskId: 'TASK-2', note: undefined }])
  })

  it('returns the service result as JSON', async () => {
    const { server, tools } = makeFakeServer()
    const { svc } = makeSvc()
    taskApprove.register(server, svc)

    const result = await tools[0].cb({ taskId: 'TASK-3' })
    const parsed = parseText<ApproveTaskResult>(result)
    expect(parsed).toEqual({ taskId: 'TASK-3', status: 'DONE', sessionId: 'SESSION-fake-1' })
  })

  it('rejects missing taskId via zod schema', () => {
    const { server, tools } = makeFakeServer()
    taskApprove.register(server, makeSvc().svc)
    const schema = tools[0].config.inputSchema
    expect(schema.taskId.safeParse(undefined).success).toBe(false)
    expect(schema.taskId.safeParse('TASK-1').success).toBe(true)
  })
})
