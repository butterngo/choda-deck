// TASK-1493 — unit test for the cross-project search route handler.

import { describe, it, expect } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'http'
import { handleSearchRoute } from './search'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'

interface Captured {
  status: number
  body: unknown
}

function fakeRes(cap: Captured): ServerResponse {
  return {
    writeHead(status: number) {
      cap.status = status
      return this
    },
    end(payload?: string) {
      cap.body = payload ? JSON.parse(payload) : undefined
      return this
    }
  } as unknown as ServerResponse
}

function req(url: string, method = 'GET'): IncomingMessage {
  return { url, method } as IncomingMessage
}

// Minimal fake: tasks span two projects; knowledge search is cross-project and
// can be toggled to the degraded (embeddings-off) shape.
function fakeSvc(opts: { knowledgeEnabled?: boolean } = {}): BackendTaskService {
  const tasks = [
    { id: 'TASK-1', title: 'graph view', projectId: 'p1', status: 'TODO' },
    { id: 'TASK-2', title: 'graph endpoint', projectId: 'p2', status: 'DONE' },
    { id: 'TASK-3', title: 'unrelated', projectId: 'p1', status: 'TODO' }
  ]
  return {
    findTasks: async (filter: { query?: string; limit?: number }) => {
      const q = (filter.query ?? '').toLowerCase()
      return tasks.filter((t) => t.title.toLowerCase().includes(q)).slice(0, filter.limit ?? 20)
    },
    searchKnowledge: async () =>
      opts.knowledgeEnabled === false
        ? { enabled: false, reason: 'embeddings disabled', results: [] }
        : {
            enabled: true,
            results: [{ slug: 'graph-gotcha', title: 'graph gotcha', projectId: 'p2' }]
          }
  } as unknown as BackendTaskService
}

describe('handleSearchRoute', () => {
  it('returns false for a non-search path', async () => {
    const cap = {} as Captured
    expect(await handleSearchRoute(req('/knowledge'), fakeRes(cap), fakeSvc())).toBe(false)
  })

  it('400s when q is missing', async () => {
    const cap = {} as Captured
    await handleSearchRoute(req('/search'), fakeRes(cap), fakeSvc())
    expect(cap.status).toBe(400)
    expect((cap.body as { error: string }).error).toMatch(/q query param/i)
  })

  it('400s on an out-of-range limit', async () => {
    const cap = {} as Captured
    await handleSearchRoute(req('/search?q=graph&limit=99'), fakeRes(cap), fakeSvc())
    expect(cap.status).toBe(400)
  })

  it('returns task hits across projects tagged with projectId', async () => {
    const cap = {} as Captured
    await handleSearchRoute(req('/search?q=graph'), fakeRes(cap), fakeSvc())
    const body = cap.body as { tasks: Array<{ id: string; projectId: string }>; knowledge: unknown[] }
    expect(cap.status).toBe(200)
    expect(body.tasks.map((t) => t.id)).toEqual(['TASK-1', 'TASK-2'])
    expect(new Set(body.tasks.map((t) => t.projectId))).toEqual(new Set(['p1', 'p2']))
    expect(body.knowledge).toHaveLength(1)
  })

  it('surfaces degraded knowledge search honestly (no silent zero)', async () => {
    const cap = {} as Captured
    await handleSearchRoute(req('/search?q=graph'), fakeRes(cap), fakeSvc({ knowledgeEnabled: false }))
    const body = cap.body as { knowledge: unknown[]; knowledgeEnabled: boolean; knowledgeReason: string }
    expect(body.knowledge).toHaveLength(0)
    expect(body.knowledgeEnabled).toBe(false)
    expect(body.knowledgeReason).toMatch(/embeddings/i)
  })
})
