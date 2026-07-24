// TASK-1172 — pillar-3 graph read endpoint. Mirrors the MCP graph_edges tool
// over plain HTTP GET, read-only, same isolation contract as TASK-1158/1171.

import type { IncomingMessage, ServerResponse } from 'http'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'
import type { RelationType } from '../../core/domain/task-types'

type GraphNodeType = 'task' | 'knowledge' | 'code_ref'

interface GraphNode {
  id: string
  type: GraphNodeType
}

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

// TASK-1443 — assemble a project's full node set (tasks + knowledge + code
// refs) so the full-graph dump can both (a) name every node's id + type for a
// client that wants to render without a second round-trip, and (b) scope the
// edge query to exactly this project's nodes — an edge only counts if BOTH
// endpoints are in this set, so nothing from another project leaks through.
async function collectProjectNodes(svc: BackendTaskService, projectId: string): Promise<GraphNode[]> {
  const [tasks, knowledge, codeRefs] = await Promise.all([
    svc.findTasks({ projectId }),
    svc.listKnowledge({ projectId }),
    svc.listCodeRefsByPrefix({ projectId })
  ])
  const nodes: GraphNode[] = []
  for (const t of tasks) nodes.push({ id: t.id, type: 'task' })
  for (const k of knowledge) nodes.push({ id: k.slug, type: 'knowledge' })
  for (const c of codeRefs) nodes.push({ id: c.slug, type: 'code_ref' })
  return nodes
}

// Route table for the graph surface. Returns false when the path is not ours
// so http-server falls through to its own routes / 404.
export async function handleGraphRoute(
  req: IncomingMessage,
  res: ServerResponse,
  svc: BackendTaskService
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname
  const method = req.method ?? 'GET'
  if (method !== 'GET' || path !== '/graph/edges') return false

  try {
    const nodeId = url.searchParams.get('node')
    if (!nodeId) {
      // AC-1 — no `node` → full-graph read, scoped by `projectId` instead.
      const projectId = url.searchParams.get('projectId')
      if (!projectId) {
        throw new GraphBadRequestError('either node or projectId query param is required')
      }
      const nodes = await collectProjectNodes(svc, projectId)
      const edges = await svc.getRelationshipsForNodes(nodes.map((n) => n.id))
      sendJson(res, 200, { nodes, edges })
      return true
    }
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
