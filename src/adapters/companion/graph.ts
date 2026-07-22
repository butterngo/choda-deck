// TASK-1172 — pillar-3 graph read endpoint. Mirrors the MCP graph_edges tool
// over plain HTTP GET, read-only, same isolation contract as TASK-1158/1171.

import type { IncomingMessage, ServerResponse } from 'http'
import type { RelationshipOperations } from '../../core/domain/interfaces/relationship-repository.interface'
import type { RelationType } from '../../core/domain/task-types'

const RELATION_TYPES: readonly RelationType[] = [
  'DEPENDS_ON',
  'IMPLEMENTS',
  'USES_TECH',
  'DECIDED_BY',
  'REALIZES',
  'ABOUT',
  'PINS',
  'IN',
  'INTEGRATES_WITH'
]

export class GraphBadRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GraphBadRequestError'
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(payload)
}

function isRelationType(v: string): v is RelationType {
  return (RELATION_TYPES as readonly string[]).includes(v)
}

// Route table for the graph surface. Returns false when the path is not ours
// so http-server falls through to its own routes / 404.
export async function handleGraphRoute(
  req: IncomingMessage,
  res: ServerResponse,
  svc: RelationshipOperations
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname
  const method = req.method ?? 'GET'
  if (method !== 'GET' || path !== '/graph/edges') return false

  try {
    const nodeId = url.searchParams.get('node')
    if (!nodeId) throw new GraphBadRequestError('node query param is required')
    const typeRaw = url.searchParams.get('type')
    if (typeRaw !== null && !isRelationType(typeRaw)) {
      throw new GraphBadRequestError(`type must be one of ${RELATION_TYPES.join('|')}`)
    }
    const type = typeRaw ?? undefined
    const direction = url.searchParams.get('direction') ?? 'both'
    if (direction !== 'out' && direction !== 'in' && direction !== 'both') {
      throw new GraphBadRequestError('direction must be out|in|both')
    }

    let edges
    if (direction === 'out') edges = await svc.getRelationshipsFrom(nodeId, type)
    else if (direction === 'in') edges = await svc.getRelationshipsTo(nodeId, type)
    else {
      const all = await svc.getRelationships(nodeId)
      edges = type ? all.filter((e) => e.type === type) : all
    }
    sendJson(res, 200, { edges })
    return true
  } catch (err) {
    if (err instanceof GraphBadRequestError) {
      sendJson(res, 400, { error: err.message })
      return true
    }
    throw err
  }
}
