import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Task } from '../../../core/domain/task-types'
import type { ProjectOperations } from '../../../core/domain/interfaces/project-repository.interface'
import type { WorkspaceOperations } from '../../../core/domain/interfaces/workspace-repository.interface'

interface GraphNode {
  id: string
  label?: string
  file_type?: string
  source_file?: string
  source_location?: string
  community?: number
}

interface GraphLink {
  source: string
  target: string
  relation?: string
  confidence?: string
  confidence_score?: number
}

interface GraphJson {
  nodes: GraphNode[]
  links: GraphLink[]
}

export interface GraphifyContext {
  affected_files: Array<{ path: string; hits: number }>
  god_nodes: Array<{ id: string; label: string; degree: number }>
  affected_communities: Array<{ id: number; label: string | null; nodeCount: number }>
  keywords_used: string[]
  graph_mtime_iso: string
  graph_age_days: number
  graph_is_stale: boolean
}

export interface GraphifyNotAvailable {
  status: 'no-graph' | 'no-matches'
  message: string
}

const STALE_DAYS = 7
const BFS_DEPTH = 2
const MAX_AFFECTED_FILES = 15
const MAX_GOD_NODES = 10
const GOD_NODE_DEGREE_THRESHOLD = 5
const CONFIDENCE_MIN = 0.7

const RELATION_FILTER = new Set<string>([
  'imports_from',
  'calls',
  'contains',
  'method',
  'implements',
  'references'
])

const KEYWORD_STOPWORDS = new Set<string>([
  'add',
  'update',
  'fix',
  'create',
  'make',
  'implement',
  'the',
  'for',
  'from',
  'into',
  'with',
  'this',
  'that',
  'and',
  'but',
  'when',
  'then',
  'thing',
  'stuff',
  'code',
  'task',
  'tasks',
  'feature',
  'work',
  'change',
  'changes'
])

export type GraphifyDeps = ProjectOperations & WorkspaceOperations

export function buildGraphifyContext(
  task: Task,
  svc: GraphifyDeps
): GraphifyContext | GraphifyNotAvailable {
  const graphPath = findGraphPath(task.projectId, svc)
  if (!graphPath) {
    return {
      status: 'no-graph',
      message:
        'No graphify-out/graph.json in project workspaces. Run `/graphify <workspace>` to enable graph-driven context.'
    }
  }

  const keywords = extractKeywords(task)
  if (keywords.length === 0) {
    return {
      status: 'no-matches',
      message: 'Task title/AC/labels produced no usable keywords.'
    }
  }

  const data = JSON.parse(fs.readFileSync(graphPath, 'utf8')) as GraphJson
  const nodeIndex = new Map<string, GraphNode>(data.nodes.map((n) => [n.id, n]))
  const adj = buildAdjacency(data.links)

  const startNodes = findStartNodes(data.nodes, keywords, 3)
  if (startNodes.length === 0) {
    return {
      status: 'no-matches',
      message: `No graph nodes matched keywords: ${keywords.join(', ')}`
    }
  }

  const subgraph = bfs(
    adj,
    startNodes.map((s) => s.id),
    BFS_DEPTH,
    RELATION_FILTER,
    CONFIDENCE_MIN
  )

  const affected_files = extractAffectedFiles(subgraph, nodeIndex, MAX_AFFECTED_FILES)
  const god_nodes = identifyGodNodes(
    subgraph,
    adj,
    nodeIndex,
    GOD_NODE_DEGREE_THRESHOLD,
    MAX_GOD_NODES
  )
  const affected_communities = identifyAffectedCommunities(subgraph, nodeIndex)
  const staleness = computeStaleness(graphPath)

  return {
    affected_files,
    god_nodes,
    affected_communities,
    keywords_used: keywords,
    ...staleness
  }
}

function findGraphPath(projectId: string, svc: GraphifyDeps): string | null {
  const workspaces = svc.findWorkspaces(projectId)
  for (const ws of workspaces) {
    const p = path.join(ws.cwd, 'graphify-out', 'graph.json')
    if (fs.existsSync(p)) return p
  }
  const project = svc.getProject(projectId)
  if (project) {
    const p = path.join(project.cwd, 'graphify-out', 'graph.json')
    if (fs.existsSync(p)) return p
  }
  return null
}

function extractKeywords(task: Task): string[] {
  const acSection = extractAcceptanceSection(task.body ?? '')
  const raw = `${task.title} ${acSection}`.split(/\s+/)
  const fromLabels = (task.labels ?? []).map((l) => l.toLowerCase())
  const all = [...raw.map((t) => t.toLowerCase()), ...fromLabels]
  const deduped = new Set<string>()
  for (const t of all) {
    const cleaned = cleanToken(t)
    if (cleaned.length <= 3) continue
    if (KEYWORD_STOPWORDS.has(cleaned)) continue
    deduped.add(cleaned)
  }
  return Array.from(deduped)
}

function cleanToken(t: string): string {
  // Strip markdown/punctuation on edges but preserve internal `_` and `-`
  // so identifiers like `session_start` and `auto-detect` stay intact.
  return t.replace(/^[^a-z0-9_-]+|[^a-z0-9_-]+$/gi, '')
}

function extractAcceptanceSection(body: string): string {
  const match = body.match(/##\s*Acceptance[\s\S]*?(?=\n##\s|\n$|$)/i)
  if (!match) return ''
  return match[0].slice(0, 500)
}

function findStartNodes(
  nodes: GraphNode[],
  keywords: string[],
  topK: number
): Array<{ id: string; score: number }> {
  const scored: Array<{ id: string; score: number }> = []
  for (const n of nodes) {
    const label = (n.label ?? '').toLowerCase()
    let score = 0
    for (const k of keywords) {
      if (label.includes(k)) score += 1
    }
    if (score > 0) scored.push({ id: n.id, score })
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (b.id > a.id) return 1
    if (b.id < a.id) return -1
    return 0
  })
  return scored.slice(0, topK)
}

type Adjacency = Map<string, Array<{ neighbor: string; link: GraphLink }>>

function buildAdjacency(links: GraphLink[]): Adjacency {
  // NetworkX loads JSON as undirected despite `directed:true` — mirror by pushing both ways.
  const adj: Adjacency = new Map()
  const push = (from: string, to: string, link: GraphLink): void => {
    if (!adj.has(from)) adj.set(from, [])
    adj.get(from)!.push({ neighbor: to, link })
  }
  for (const l of links) {
    push(l.source, l.target, l)
    push(l.target, l.source, l)
  }
  return adj
}

function bfs(
  adj: Adjacency,
  startNodes: string[],
  depth: number,
  relationFilter: Set<string>,
  confidenceMin: number
): Set<string> {
  const visited = new Set<string>(startNodes)
  let frontier = new Set<string>(startNodes)
  for (let d = 0; d < depth; d += 1) {
    const next = new Set<string>()
    for (const n of frontier) {
      const neighbors = adj.get(n) ?? []
      for (const { neighbor, link } of neighbors) {
        if (link.relation && !relationFilter.has(link.relation)) continue
        if ((link.confidence_score ?? 1) < confidenceMin) continue
        if (!visited.has(neighbor)) next.add(neighbor)
      }
    }
    for (const n of next) visited.add(n)
    frontier = next
  }
  return visited
}

function extractAffectedFiles(
  subgraph: Set<string>,
  nodeIndex: Map<string, GraphNode>,
  max: number
): Array<{ path: string; hits: number }> {
  const hits = new Map<string, number>()
  for (const id of subgraph) {
    const n = nodeIndex.get(id)
    if (!n?.source_file) continue
    hits.set(n.source_file, (hits.get(n.source_file) ?? 0) + 1)
  }
  return Array.from(hits.entries())
    .map(([p, h]) => ({ path: p, hits: h }))
    .sort((a, b) => b.hits - a.hits)
    .slice(0, max)
}

function identifyGodNodes(
  subgraph: Set<string>,
  adj: Adjacency,
  nodeIndex: Map<string, GraphNode>,
  threshold: number,
  max: number
): Array<{ id: string; label: string; degree: number }> {
  const result: Array<{ id: string; label: string; degree: number }> = []
  for (const id of subgraph) {
    const deg = (adj.get(id) ?? []).length
    if (deg >= threshold) {
      result.push({ id, label: nodeIndex.get(id)?.label ?? id, degree: deg })
    }
  }
  return result.sort((a, b) => b.degree - a.degree).slice(0, max)
}

function identifyAffectedCommunities(
  subgraph: Set<string>,
  nodeIndex: Map<string, GraphNode>
): Array<{ id: number; label: string | null; nodeCount: number }> {
  const counts = new Map<number, number>()
  for (const id of subgraph) {
    const n = nodeIndex.get(id)
    if (typeof n?.community !== 'number') continue
    counts.set(n.community, (counts.get(n.community) ?? 0) + 1)
  }
  return Array.from(counts.entries())
    .map(([cid, count]) => ({ id: cid, label: null, nodeCount: count }))
    .sort((a, b) => b.nodeCount - a.nodeCount)
}

function computeStaleness(graphPath: string): {
  graph_mtime_iso: string
  graph_age_days: number
  graph_is_stale: boolean
} {
  const stat = fs.statSync(graphPath)
  const mtimeMs = stat.mtimeMs
  const ageMs = Date.now() - mtimeMs
  const ageDays = ageMs / (1000 * 60 * 60 * 24)
  return {
    graph_mtime_iso: new Date(mtimeMs).toISOString(),
    graph_age_days: Math.round(ageDays * 10) / 10,
    graph_is_stale: ageDays > STALE_DAYS
  }
}
