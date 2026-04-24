#!/usr/bin/env node
/**
 * Spike: port graphify BFS query from Python (skill.md) to TypeScript.
 * Reads graphify-out/graph.json, runs keyword match + BFS traversal,
 * outputs affected_files + god_nodes. Matches Python behaviour so we can
 * verify the port against `python -m graphify ... query`.
 *
 * Run:
 *   pnpm tsx scripts/spike-graphify-query.ts "<question>" [--depth N]
 *       [--apply-task-607-filters]
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

type NodeData = {
  id: string
  label?: string
  file_type?: string
  source_file?: string
  source_location?: string
  community?: number
}

type LinkData = {
  source: string
  target: string
  relation?: string
  confidence?: string
  confidence_score?: number
  source_file?: string
  source_location?: string
}

type GraphJson = {
  nodes: NodeData[]
  links: LinkData[]
}

type QueryResult = {
  keywords: string[]
  startNodes: Array<{ id: string; label: string; score: number }>
  subgraphNodeCount: number
  affected_files: Array<{ path: string; hits: number }>
  god_nodes: Array<{ id: string; label: string; degree: number }>
  mode: 'python-parity' | 'task-607'
  depth: number
  durationMs: number
}

function parseArgs(argv: string[]): {
  question: string
  depth: number
  applyTask607Filters: boolean
  graphPath: string
} {
  const args = argv.slice(2)
  let question = ''
  let depth = 3
  let applyTask607Filters = false
  let graphPath = path.join(process.cwd(), 'graphify-out', 'graph.json')

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]
    if (a === '--depth') {
      depth = parseInt(args[++i] ?? '3', 10)
    } else if (a === '--apply-task-607-filters') {
      applyTask607Filters = true
      depth = 2
    } else if (a === '--graph') {
      graphPath = args[++i] ?? graphPath
    } else if (!question) {
      question = a
    } else {
      question += ' ' + a
    }
  }

  if (!question) {
    console.error('Usage: spike-graphify-query.ts "<question>" [--depth N] [--apply-task-607-filters] [--graph path]')
    process.exit(1)
  }

  return { question, depth, applyTask607Filters, graphPath }
}

function extractKeywords(question: string): string[] {
  // Mirror Python SKILL.md exactly: split on whitespace, lowercase, keep len > 3.
  // Do NOT strip underscores/hyphens — `session_start` and `auto-detect` must stay
  // intact to match substrings in node labels / ids.
  return question
    .split(/\s+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 3)
}

function findStartNodes(
  nodes: NodeData[],
  keywords: string[],
  topK = 3,
): Array<{ id: string; label: string; score: number }> {
  const scored: Array<{ id: string; label: string; score: number }> = []
  for (const n of nodes) {
    const label = (n.label ?? '').toLowerCase()
    let score = 0
    for (const k of keywords) {
      if (label.includes(k)) score += 1
    }
    if (score > 0) scored.push({ id: n.id, label: n.label ?? n.id, score })
  }
  // Sort by score desc, tie-break by id codepoint desc (matches Python `sort(reverse=True)` on (score, nid) tuples).
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (b.id > a.id) return 1
    if (b.id < a.id) return -1
    return 0
  })
  return scored.slice(0, topK)
}

type Adjacency = Map<string, Array<{ neighbor: string; link: LinkData }>>

function buildAdjacency(links: LinkData[]): Adjacency {
  // Python baseline (json_graph.node_link_graph) loads the graph as UNDIRECTED
  // (despite directed:true in JSON — NetworkX quirk). G.neighbors returns both
  // successors and predecessors. Mirror that here: add both directions.
  const adj: Adjacency = new Map()
  const push = (from: string, to: string, link: LinkData) => {
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
  relationFilter: Set<string> | null,
  confidenceMin: number,
): { nodes: Set<string>; edges: Array<{ u: string; v: string; link: LinkData }> } {
  const visited = new Set<string>(startNodes)
  const edges: Array<{ u: string; v: string; link: LinkData }> = []
  let frontier = new Set<string>(startNodes)

  for (let d = 0; d < depth; d += 1) {
    const next = new Set<string>()
    for (const n of frontier) {
      const neighbors = adj.get(n) ?? []
      for (const { neighbor, link } of neighbors) {
        if (relationFilter && link.relation && !relationFilter.has(link.relation)) continue
        if ((link.confidence_score ?? 1) < confidenceMin) continue
        if (!visited.has(neighbor)) {
          next.add(neighbor)
          edges.push({ u: n, v: neighbor, link })
        }
      }
    }
    for (const n of next) visited.add(n)
    frontier = next
  }

  return { nodes: visited, edges }
}

function extractAffectedFiles(
  subgraphNodes: Set<string>,
  nodeIndex: Map<string, NodeData>,
  max = 15,
): Array<{ path: string; hits: number }> {
  const hits = new Map<string, number>()
  for (const id of subgraphNodes) {
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
  subgraphNodes: Set<string>,
  adj: Adjacency,
  nodeIndex: Map<string, NodeData>,
  threshold = 5,
  max = 10,
): Array<{ id: string; label: string; degree: number }> {
  const result: Array<{ id: string; label: string; degree: number }> = []
  for (const id of subgraphNodes) {
    const deg = (adj.get(id) ?? []).length
    if (deg >= threshold) {
      result.push({
        id,
        label: nodeIndex.get(id)?.label ?? id,
        degree: deg,
      })
    }
  }
  return result.sort((a, b) => b.degree - a.degree).slice(0, max)
}

function main() {
  const { question, depth, applyTask607Filters, graphPath } = parseArgs(process.argv)

  if (!fs.existsSync(graphPath)) {
    console.error(`ERROR: graph file not found: ${graphPath}`)
    process.exit(1)
  }

  const t0 = Date.now()
  const data: GraphJson = JSON.parse(fs.readFileSync(graphPath, 'utf8'))
  const keywords = extractKeywords(question)
  const startNodes = findStartNodes(data.nodes, keywords, 3)
  const nodeIndex = new Map<string, NodeData>(data.nodes.map((n) => [n.id, n]))
  const adj = buildAdjacency(data.links)

  // TASK-607 filters: relation subset + confidence >= 0.7
  // Map CALLS/IMPLEMENTS/EXTENDS/USES -> actual relations in graph:
  //   CALLS -> calls
  //   IMPLEMENTS -> implements
  //   EXTENDS -> (not present in graph, dropped)
  //   USES -> imports_from + references (best-effort; see report)
  const relationFilter = applyTask607Filters
    ? new Set<string>(['calls', 'implements', 'imports_from', 'references'])
    : null
  const confidenceMin = applyTask607Filters ? 0.7 : 0

  const { nodes: subgraphNodes } = bfs(
    adj,
    startNodes.map((s) => s.id),
    depth,
    relationFilter,
    confidenceMin,
  )

  const affected_files = extractAffectedFiles(subgraphNodes, nodeIndex, 15)
  const god_nodes = identifyGodNodes(subgraphNodes, adj, nodeIndex, 5, 10)
  const durationMs = Date.now() - t0

  const result: QueryResult = {
    keywords,
    startNodes,
    subgraphNodeCount: subgraphNodes.size,
    affected_files,
    god_nodes,
    mode: applyTask607Filters ? 'task-607' : 'python-parity',
    depth,
    durationMs,
  }

  console.log(JSON.stringify(result, null, 2))
}

main()
