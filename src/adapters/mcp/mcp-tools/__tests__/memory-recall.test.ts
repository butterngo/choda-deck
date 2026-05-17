import { describe, it, expect, vi } from 'vitest'
import * as memoryRecall from '../memory-recall'
import type { InstrumentedServer } from '../../instrumented-server'
import type { AgentMemoryOperations, MemoryRecallInput } from '../../../../core/domain/interfaces/agent-memory-operations.interface'
import type { AgentMemory } from '../../../../core/domain/task-types'

interface CapturedTool {
  name: string
  cb: (args: unknown) => Promise<unknown>
}

function makeFakeServer(): { server: InstrumentedServer; tools: CapturedTool[] } {
  const tools: CapturedTool[] = []
  const server: InstrumentedServer = {
    registerTool: vi.fn((name: string, _config: unknown, cb: (args: unknown) => Promise<unknown>) => {
      tools.push({ name, cb })
      return { name } as never
    }) as unknown as InstrumentedServer['registerTool'],
    get registeredToolNames(): ReadonlyArray<string> {
      return []
    }
  }
  return { server, tools }
}

function makeMemory(id: string, importance = 50): AgentMemory {
  return {
    id,
    scopeType: 'task',
    scopeId: 'TASK-1',
    memoryType: 'episodic',
    content: 'some memory',
    tags: [],
    importance,
    sourceSessionId: null,
    sourceEventIds: [],
    createdAt: '2026-05-17T00:00:00.000Z',
    lastRecalledAt: null,
    recallCount: 0
  }
}

function makeSvc(returned: AgentMemory[]): { svc: AgentMemoryOperations; calls: MemoryRecallInput[] } {
  const calls: MemoryRecallInput[] = []
  return {
    svc: {
      writeMemory: vi.fn(() => makeMemory('MEM-0')),
      recallMemories: vi.fn((input: MemoryRecallInput) => { calls.push(input); return returned }),
      markMemoryPromoted: vi.fn()
    },
    calls
  }
}

function parseText<T>(result: unknown): T {
  const r = result as { content: Array<{ type: string; text: string }> }
  return JSON.parse(r.content[0].text) as T
}

describe('memory-recall.register', () => {
  it('registers exactly one tool named memory_recall', () => {
    const { server, tools } = makeFakeServer()
    memoryRecall.register(server, makeSvc([]).svc)
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('memory_recall')
  })

  it('returns error when no scope ID provided', async () => {
    const { server, tools } = makeFakeServer()
    memoryRecall.register(server, makeSvc([]).svc)

    const result = await tools[0].cb({})
    const parsed = parseText<{ error: string }>(result)
    expect(parsed.error).toMatch(/scope ID/)
  })

  it('returns memories for a given taskId', async () => {
    const memories = [makeMemory('MEM-1', 80), makeMemory('MEM-2', 40)]
    const { server, tools } = makeFakeServer()
    const { svc, calls } = makeSvc(memories)
    memoryRecall.register(server, svc)

    const result = await tools[0].cb({ taskId: 'TASK-1' })
    const parsed = parseText<AgentMemory[]>(result)
    expect(parsed).toHaveLength(2)
    expect(calls[0]).toMatchObject({ taskId: 'TASK-1' })
  })

  it('forwards tags and limit', async () => {
    const { server, tools } = makeFakeServer()
    const { svc, calls } = makeSvc([])
    memoryRecall.register(server, svc)

    await tools[0].cb({ projectId: 'proj-1', tags: ['lint'], limit: 3 })
    expect(calls[0]).toMatchObject({ projectId: 'proj-1', tags: ['lint'], limit: 3 })
  })
})
