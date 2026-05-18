import { describe, it, expect, vi } from 'vitest'
import * as knowledgeTools from '../knowledge-tools'
import type { InstrumentedServer } from '../../instrumented-server'
import type { KnowledgeOperations } from '../../../../core/domain/interfaces/knowledge-operations.interface'
import type {
  KnowledgeEntry,
  RegisterExistingKnowledgeInput
} from '../../../../core/domain/knowledge-types'

interface CapturedTool {
  name: string
  cb: (args: unknown) => Promise<unknown>
}

function makeFakeServer(): { server: InstrumentedServer; tools: CapturedTool[] } {
  const tools: CapturedTool[] = []
  const server: InstrumentedServer = {
    registerTool: vi.fn(
      (name: string, _config: unknown, cb: (args: unknown) => Promise<unknown>) => {
        tools.push({ name, cb })
        return { name } as never
      }
    ) as unknown as InstrumentedServer['registerTool'],
    get registeredToolNames(): ReadonlyArray<string> {
      return []
    }
  }
  return { server, tools }
}

function makeEntry(slug: string, workspaceId: string | null = null): KnowledgeEntry {
  return {
    slug,
    frontmatter: {
      type: 'decision',
      title: 'Pre-existing ADR',
      projectId: 'proj-1',
      workspaceId: workspaceId ?? undefined,
      scope: 'project',
      refs: [],
      createdAt: '2026-04-01',
      lastVerifiedAt: '2026-05-18'
    },
    body: 'pre-existing body',
    filePath: `C:\\dev\\repo\\docs\\knowledge\\${slug}.md`,
    staleness: [],
    isStale: false
  }
}

function makeSvc(entry: KnowledgeEntry): {
  svc: KnowledgeOperations
  registerCalls: RegisterExistingKnowledgeInput[]
} {
  const registerCalls: RegisterExistingKnowledgeInput[] = []
  const svc: KnowledgeOperations = {
    createKnowledge: vi.fn(),
    registerExistingKnowledge: vi.fn((input: RegisterExistingKnowledgeInput) => {
      registerCalls.push(input)
      return entry
    }),
    getKnowledge: vi.fn(() => null),
    listKnowledge: vi.fn(() => []),
    updateKnowledge: vi.fn(),
    verifyKnowledge: vi.fn(),
    deleteKnowledge: vi.fn(),
    searchKnowledge: vi.fn()
  } as unknown as KnowledgeOperations
  return { svc, registerCalls }
}

function parseText<T>(result: unknown): T {
  const r = result as { content: Array<{ type: string; text: string }> }
  return JSON.parse(r.content[0].text) as T
}

function findTool(tools: CapturedTool[], name: string): CapturedTool {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`tool ${name} not registered`)
  return t
}

describe('knowledge_register_existing MCP tool', () => {
  it('is registered alongside the other knowledge_* tools', () => {
    const { server, tools } = makeFakeServer()
    const { svc } = makeSvc(makeEntry('adr-x'))
    knowledgeTools.register(server, svc)

    const names = tools.map((t) => t.name)
    expect(names).toContain('knowledge_register_existing')
    expect(names).toContain('knowledge_create')
    expect(names).toContain('knowledge_get')
  })

  it('forwards filePath + projectId to registerExistingKnowledge', async () => {
    const { server, tools } = makeFakeServer()
    const { svc, registerCalls } = makeSvc(makeEntry('adr-x'))
    knowledgeTools.register(server, svc)

    await findTool(tools, 'knowledge_register_existing').cb({
      filePath: 'C:\\dev\\repo\\docs\\knowledge\\adr-x.md',
      projectId: 'proj-1'
    })

    expect(registerCalls).toHaveLength(1)
    expect(registerCalls[0]).toEqual({
      filePath: 'C:\\dev\\repo\\docs\\knowledge\\adr-x.md',
      projectId: 'proj-1',
      workspaceId: undefined
    })
  })

  it('forwards workspaceId when provided', async () => {
    const { server, tools } = makeFakeServer()
    const { svc, registerCalls } = makeSvc(makeEntry('adr-ws', 'ws-1'))
    knowledgeTools.register(server, svc)

    await findTool(tools, 'knowledge_register_existing').cb({
      filePath: 'C:\\dev\\repo\\docs\\knowledge\\adr-ws.md',
      projectId: 'proj-1',
      workspaceId: 'ws-1'
    })

    expect(registerCalls[0].workspaceId).toBe('ws-1')
  })

  it('returns the entry produced by the service as JSON text', async () => {
    const { server, tools } = makeFakeServer()
    const entry = makeEntry('adr-x')
    const { svc } = makeSvc(entry)
    knowledgeTools.register(server, svc)

    const result = await findTool(tools, 'knowledge_register_existing').cb({
      filePath: 'C:\\dev\\repo\\docs\\knowledge\\adr-x.md',
      projectId: 'proj-1'
    })

    const parsed = parseText<KnowledgeEntry>(result)
    expect(parsed.slug).toBe('adr-x')
    expect(parsed.frontmatter.projectId).toBe('proj-1')
  })
})
