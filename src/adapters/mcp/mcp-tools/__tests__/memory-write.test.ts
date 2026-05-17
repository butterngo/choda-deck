import { describe, it, expect, vi } from 'vitest'
import * as memoryWrite from '../memory-write'
import type { InstrumentedServer } from '../../instrumented-server'
import type { AgentMemoryOperations } from '../../../../core/domain/interfaces/agent-memory-operations.interface'
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

function makeMemory(overrides: Partial<AgentMemory> = {}): AgentMemory {
  return {
    id: 'MEM-001',
    scopeType: 'task',
    scopeId: 'TASK-1',
    memoryType: 'episodic',
    content: 'did the thing',
    tags: [],
    importance: 50,
    sourceSessionId: null,
    sourceEventIds: [],
    createdAt: '2026-05-17T00:00:00.000Z',
    lastRecalledAt: null,
    recallCount: 0,
    ...overrides
  }
}

function makeSvc(returned: AgentMemory): { svc: AgentMemoryOperations; calls: unknown[] } {
  const calls: unknown[] = []
  return {
    svc: {
      writeMemory: vi.fn((input) => { calls.push(input); return returned }),
      recallMemories: vi.fn(() => []),
      markMemoryPromoted: vi.fn()
    },
    calls
  }
}

function parseText<T>(result: unknown): T {
  const r = result as { content: Array<{ type: string; text: string }> }
  return JSON.parse(r.content[0].text) as T
}

describe('memory-write.register', () => {
  it('registers exactly one tool named memory_write', () => {
    const { server, tools } = makeFakeServer()
    memoryWrite.register(server, makeSvc(makeMemory()).svc)
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('memory_write')
  })

  it('calls writeMemory and returns id + createdAt', async () => {
    const { server, tools } = makeFakeServer()
    const mem = makeMemory({ id: 'MEM-XYZ' })
    const { svc } = makeSvc(mem)
    memoryWrite.register(server, svc)

    const result = await tools[0].cb({
      scopeType: 'task',
      scopeId: 'TASK-1',
      memoryType: 'episodic',
      content: 'did the thing'
    })
    const parsed = parseText<{ id: string }>(result)
    expect(parsed.id).toBe('MEM-XYZ')
  })

  it('forwards all optional fields', async () => {
    const { server, tools } = makeFakeServer()
    const { svc, calls } = makeSvc(makeMemory())
    memoryWrite.register(server, svc)

    await tools[0].cb({
      scopeType: 'project',
      scopeId: 'proj-1',
      memoryType: 'procedural',
      content: 'always run lint before commit',
      tags: ['lint', 'workflow'],
      importance: 80,
      sourceSessionId: 'SES-1',
      sourceEventIds: ['EVT-1', 'EVT-2']
    })
    const call = calls[0] as Record<string, unknown>
    expect(call.scopeType).toBe('project')
    expect(call.importance).toBe(80)
    expect(call.tags).toEqual(['lint', 'workflow'])
    expect(call.sourceEventIds).toEqual(['EVT-1', 'EVT-2'])
  })
})
