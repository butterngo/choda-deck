// TASK-1172 — pillar-3 knowledge read endpoints. Mirrors the MCP knowledge_list
// / knowledge_get / knowledge_search tools over plain HTTP GET, read-only, same
// isolation contract as TASK-1158/1171 (zero MCP edits, localhost-only).

import type { IncomingMessage, ServerResponse } from 'http'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'
import type { KnowledgeScope, KnowledgeType } from '../../core/domain/knowledge-types'
import { KNOWLEDGE_SCOPES, KNOWLEDGE_TYPES } from '../../core/domain/knowledge-types'

export class KnowledgeBadRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KnowledgeBadRequestError'
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(payload)
}

function isKnowledgeType(v: string): v is KnowledgeType {
  return (KNOWLEDGE_TYPES as readonly string[]).includes(v)
}

function isKnowledgeScope(v: string): v is KnowledgeScope {
  return (KNOWLEDGE_SCOPES as readonly string[]).includes(v)
}

// Route table for the knowledge surface. Returns false when the path is not
// ours so http-server falls through to its own routes / 404.
export async function handleKnowledgeRoute(
  req: IncomingMessage,
  res: ServerResponse,
  svc: BackendTaskService
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname
  const method = req.method ?? 'GET'
  if (method !== 'GET' || !path.startsWith('/knowledge')) return false

  try {
    if (path === '/knowledge/search') {
      const query = url.searchParams.get('q')
      if (!query) throw new KnowledgeBadRequestError('q query param is required')
      const topKRaw = url.searchParams.get('topK')
      const topK = topKRaw === null ? undefined : Number(topKRaw)
      if (topK !== undefined && (!Number.isInteger(topK) || topK < 1 || topK > 50)) {
        throw new KnowledgeBadRequestError('topK must be an integer between 1 and 50')
      }
      sendJson(res, 200, await svc.searchKnowledge(query, topK))
      return true
    }
    if (path === '/knowledge') {
      const projectId = url.searchParams.get('projectId') ?? undefined
      const workspaceIdRaw = url.searchParams.get('workspaceId')
      const workspaceId = workspaceIdRaw === null ? undefined : workspaceIdRaw === '' ? null : workspaceIdRaw
      const scopeRaw = url.searchParams.get('scope')
      if (scopeRaw !== null && !isKnowledgeScope(scopeRaw)) {
        throw new KnowledgeBadRequestError(`scope must be one of ${KNOWLEDGE_SCOPES.join('|')}`)
      }
      const typeRaw = url.searchParams.get('type')
      if (typeRaw !== null && !isKnowledgeType(typeRaw)) {
        throw new KnowledgeBadRequestError(`type must be one of ${KNOWLEDGE_TYPES.join('|')}`)
      }
      sendJson(
        res,
        200,
        {
          entries: await svc.listKnowledge({
            projectId,
            workspaceId,
            scope: scopeRaw ?? undefined,
            type: typeRaw ?? undefined
          })
        }
      )
      return true
    }
    const getMatch = path.match(/^\/knowledge\/([^/]+)$/)
    if (getMatch) {
      const entry = await svc.getKnowledge(decodeURIComponent(getMatch[1]))
      if (!entry) {
        sendJson(res, 404, { error: `unknown knowledge slug: ${getMatch[1]}` })
        return true
      }
      sendJson(res, 200, entry)
      return true
    }
    return false
  } catch (err) {
    if (err instanceof KnowledgeBadRequestError) {
      sendJson(res, 400, { error: err.message })
      return true
    }
    throw err
  }
}
