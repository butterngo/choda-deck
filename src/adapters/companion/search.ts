// TASK-1493 — cross-project search. A single GET /search?q= fans a title match
// over ALL projects' tasks (findTasks' `query` runs cross-project when projectId
// is omitted — see buildTaskQuery) and the already-cross-project knowledge
// embedding search, returning hits tagged with projectId so the companion can
// label + group results by project. Read-only, same localhost-only contract as
// the other companion read routes (TASK-1172/1443).

import type { IncomingMessage, ServerResponse } from 'http'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'

export class SearchBadRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SearchBadRequestError'
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

// Route table for the cross-project search surface. Returns false when the path
// is not ours so http-server falls through to its own routes / 404.
export async function handleSearchRoute(
  req: IncomingMessage,
  res: ServerResponse,
  svc: BackendTaskService
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if ((req.method ?? 'GET') !== 'GET' || url.pathname !== '/search') return false

  try {
    const query = url.searchParams.get('q')
    if (!query) throw new SearchBadRequestError('q query param is required')
    const limitRaw = url.searchParams.get('limit')
    const limit = limitRaw === null ? 20 : Number(limitRaw)
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new SearchBadRequestError('limit must be an integer between 1 and 50')
    }

    // Tasks: title LIKE across every project (no projectId filter).
    const taskRows = await svc.findTasks({ query, limit })
    const tasks = taskRows.map((t) => ({
      kind: 'task' as const,
      id: t.id,
      title: t.title,
      projectId: t.projectId,
      status: t.status
    }))

    // Knowledge: embedding search is already cross-project; it may be degraded
    // (embeddings disabled in the packaged app) — surface enabled/reason so the
    // UI can say so rather than silently show zero knowledge hits.
    const kn = await svc.searchKnowledge(query, limit)
    const knowledge = (kn.enabled ? kn.results : []).map((k) => ({
      kind: 'knowledge' as const,
      id: k.slug,
      title: k.title,
      projectId: k.projectId
    }))

    sendJson(res, 200, {
      query,
      tasks,
      knowledge,
      knowledgeEnabled: kn.enabled,
      knowledgeReason: kn.reason ?? null
    })
    return true
  } catch (err) {
    if (err instanceof SearchBadRequestError) {
      sendJson(res, 400, { error: err.message })
      return true
    }
    throw err
  }
}
