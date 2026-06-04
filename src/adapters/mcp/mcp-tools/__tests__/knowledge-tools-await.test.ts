import { describe, it, expect, vi } from 'vitest'
import * as knowledgeTools from '../knowledge-tools'
import type { InstrumentedServer } from '../../instrumented-server'
import type { KnowledgeOperations } from '../../../../core/domain/interfaces/knowledge-operations.interface'
import type {
  KnowledgeEntry,
  KnowledgeListFilter,
  KnowledgeListItem
} from '../../../../core/domain/knowledge-types'

// Regression guard for TASK-990: every knowledge_* handler must `await` the
// async KnowledgeOperations facade before handing the result to textResponse.
// The facade returns Promise<…> for all methods; a missing await stringifies the
// pending Promise to "{}" — which is exactly how knowledge_list/get reached the
// user empty in the 2026-05-29 PIM pilot. Mocks here are ASYNC on purpose: the
// pre-existing tool tests used sync mocks, which made the missing await invisible.

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

function parseText<T>(result: unknown): T {
  const r = result as { content: Array<{ type: string; text: string }> }
  return JSON.parse(r.content[0].text) as T
}

function findTool(tools: CapturedTool[], name: string): CapturedTool {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`tool ${name} not registered`)
  return t
}

function listItem(slug: string): KnowledgeListItem {
  return {
    slug,
    projectId: 'pim',
    workspaceId: null,
    scope: 'project',
    type: 'decision',
    title: slug,
    filePath: `C:\\repo\\${slug}.md`,
    createdAt: '2026-05-29',
    lastVerifiedAt: '2026-05-29',
    isStale: false
  } as unknown as KnowledgeListItem
}

function getEntry(slug: string): KnowledgeEntry {
  return {
    slug,
    frontmatter: {
      type: 'decision',
      title: slug,
      projectId: 'pim',
      workspaceId: undefined,
      scope: 'project',
      refs: [],
      createdAt: '2026-05-29',
      lastVerifiedAt: '2026-05-29'
    },
    body: 'body',
    filePath: `C:\\repo\\${slug}.md`,
    staleness: [],
    isStale: false
  }
}

describe('knowledge_* handlers await the async facade (TASK-990)', () => {
  it('knowledge_list resolves the Promise — returns rows, not "{}"', async () => {
    const { server, tools } = makeFakeServer()
    const listCalls: (KnowledgeListFilter | undefined)[] = []
    const svc = {
      listKnowledge: vi.fn(async (filter?: KnowledgeListFilter) => {
        listCalls.push(filter)
        return [listItem('a'), listItem('b')]
      })
    } as unknown as KnowledgeOperations
    knowledgeTools.register(server, svc)

    const result = await findTool(tools, 'knowledge_list').cb({ projectId: 'pim' })
    const parsed = parseText<KnowledgeListItem[]>(result)

    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(2)
    expect(parsed.map((r) => r.slug)).toEqual(['a', 'b'])
  })

  it('knowledge_list maps workspaceId: omitted → undefined, "" → null (AC#1–3)', async () => {
    const { server, tools } = makeFakeServer()
    const listCalls: (KnowledgeListFilter | undefined)[] = []
    const svc = {
      listKnowledge: vi.fn(async (filter?: KnowledgeListFilter) => {
        listCalls.push(filter)
        return []
      })
    } as unknown as KnowledgeOperations
    knowledgeTools.register(server, svc)
    const list = findTool(tools, 'knowledge_list')

    await list.cb({ projectId: 'pim' })
    await list.cb({ projectId: 'pim', workspaceId: '' })
    await list.cb({ projectId: 'pim', workspaceId: 'pim-trading-api' })

    expect(listCalls[0]?.workspaceId).toBeUndefined()
    expect(listCalls[1]?.workspaceId).toBeNull()
    expect(listCalls[2]?.workspaceId).toBe('pim-trading-api')
  })

  it('knowledge_get resolves the Promise — returns the entry, not "{}"', async () => {
    const { server, tools } = makeFakeServer()
    const svc = {
      getKnowledge: vi.fn(async (slug: string) => getEntry(slug))
    } as unknown as KnowledgeOperations
    knowledgeTools.register(server, svc)

    const result = await findTool(tools, 'knowledge_get').cb({ slug: 'a' })
    const parsed = parseText<KnowledgeEntry>(result)

    expect(parsed.slug).toBe('a')
    expect(parsed.frontmatter.projectId).toBe('pim')
  })

  it('knowledge_get awaits before the not-found check — null yields the message', async () => {
    const { server, tools } = makeFakeServer()
    const svc = {
      getKnowledge: vi.fn(async () => null)
    } as unknown as KnowledgeOperations
    knowledgeTools.register(server, svc)

    const result = await findTool(tools, 'knowledge_get').cb({ slug: 'missing' })
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(text).toBe('Knowledge missing not found')
  })
})
