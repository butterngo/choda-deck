import { describe, it, expect, vi } from 'vitest'
import * as memoryPromote from '../memory-promote-to-knowledge'
import type { InstrumentedServer } from '../../instrumented-server'
import type { MemoryPromoteDeps } from '../memory-promote-to-knowledge'
import type { KnowledgeEntry } from '../../../../core/domain/knowledge-types'

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

function makeEntry(slug: string): KnowledgeEntry {
  return {
    slug,
    projectId: 'proj-1',
    workspaceId: null,
    type: 'decision',
    scope: 'project',
    title: 'Test ADR',
    body: 'body text',
    filePath: `docs/knowledge/${slug}.md`,
    refs: [],
    createdAt: '2026-05-17T00:00:00.000Z',
    updatedAt: '2026-05-17T00:00:00.000Z'
  }
}

function makeSvc(slug: string): {
  svc: MemoryPromoteDeps
  createCalls: unknown[]
  promoteCalls: Array<{ memoryId: string; adrSlug: string }>
} {
  const createCalls: unknown[] = []
  const promoteCalls: Array<{ memoryId: string; adrSlug: string }> = []
  const entry = makeEntry(slug)
  const svc = {
    writeMemory: vi.fn(),
    recallMemories: vi.fn(() => []),
    markMemoryPromoted: vi.fn((memoryId: string, adrSlug: string) => { promoteCalls.push({ memoryId, adrSlug }) }),
    createKnowledge: vi.fn((input: unknown) => { createCalls.push(input); return entry }),
    registerExistingKnowledge: vi.fn(),
    getKnowledge: vi.fn(() => null),
    listKnowledge: vi.fn(() => []),
    updateKnowledge: vi.fn(),
    verifyKnowledge: vi.fn(),
    deleteKnowledge: vi.fn(),
    searchKnowledge: vi.fn()
  } as unknown as MemoryPromoteDeps
  return { svc, createCalls, promoteCalls }
}

function parseText<T>(result: unknown): T {
  const r = result as { content: Array<{ type: string; text: string }> }
  return JSON.parse(r.content[0].text) as T
}

describe('memory-promote-to-knowledge.register', () => {
  it('registers exactly one tool named memory_promote_to_knowledge', () => {
    const { server, tools } = makeFakeServer()
    memoryPromote.register(server, makeSvc('adr-test').svc)
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('memory_promote_to_knowledge')
  })

  it('calls createKnowledge with type=decision and returns slug + filePath', async () => {
    const { server, tools } = makeFakeServer()
    const { svc, createCalls } = makeSvc('adr-my-decision')
    memoryPromote.register(server, svc)

    const result = await tools[0].cb({
      memoryId: 'MEM-1',
      projectId: 'proj-1',
      title: 'My Decision',
      body: 'We decided to do X'
    })
    const parsed = parseText<{ slug: string; filePath: string }>(result)
    expect(parsed.slug).toBe('adr-my-decision')
    expect((createCalls[0] as { type: string }).type).toBe('decision')
  })

  it('marks the memory as promoted with the ADR slug', async () => {
    const { server, tools } = makeFakeServer()
    const { svc, promoteCalls } = makeSvc('adr-slug')
    memoryPromote.register(server, svc)

    await tools[0].cb({ memoryId: 'MEM-42', projectId: 'proj-1', title: 'T', body: 'B' })
    expect(promoteCalls).toHaveLength(1)
    expect(promoteCalls[0]).toEqual({ memoryId: 'MEM-42', adrSlug: 'adr-slug' })
  })

  it('forwards workspaceId when provided', async () => {
    const { server, tools } = makeFakeServer()
    const { svc, createCalls } = makeSvc('adr-ws')
    memoryPromote.register(server, svc)

    await tools[0].cb({
      memoryId: 'MEM-1',
      projectId: 'proj-1',
      workspaceId: 'ws-1',
      title: 'WS ADR',
      body: 'body'
    })
    expect((createCalls[0] as { workspaceId: string }).workspaceId).toBe('ws-1')
  })
})
