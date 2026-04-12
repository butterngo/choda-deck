#!/usr/bin/env node
/**
 * Graph CLI — terminal interface for graph operations
 * Usage: npx ts-node src/graph/graph-cli.ts <command> [options]
 */

import { Command } from 'commander'
import { Neo4jGraphService } from './neo4j-graph-service'
import { NodeType, RelationType, buildUid } from './graph-types'
import type { GraphNode, ContextResult } from './graph-types'
import type { Neo4jProviderConfig } from './graph-config'
import * as fs from 'fs'
import * as path from 'path'

// ── Config resolution ──────────────────────────────────────────────────────────

function loadConfig(): Neo4jProviderConfig {
  // Try config file first
  const configPath = path.join(process.cwd(), 'choda-deck.config.json')
  if (fs.existsSync(configPath)) {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    if (raw.neo4j) {
      return {
        provider: 'neo4j',
        uri: raw.neo4j.uri || 'bolt://localhost:7687',
        username: raw.neo4j.username || 'neo4j',
        password: raw.neo4j.password || 'neo4j',
        database: raw.neo4j.database
      }
    }
  }

  // Fallback to env vars
  return {
    provider: 'neo4j',
    uri: process.env.NEO4J_URI || 'bolt://localhost:7687',
    username: process.env.NEO4J_USER || 'neo4j',
    password: process.env.NEO4J_PASSWORD || 'neo4j',
    database: process.env.NEO4J_DATABASE
  }
}

async function withService<T>(fn: (svc: Neo4jGraphService) => Promise<T>): Promise<T> {
  const config = loadConfig()
  const svc = new Neo4jGraphService(config)
  try {
    await svc.connect()
    return await fn(svc)
  } finally {
    await svc.disconnect()
  }
}

// ── UID resolution ─────────────────────────────────────────────────────────────

async function resolveUid(svc: Neo4jGraphService, shortId: string): Promise<string> {
  // If already a full uid (contains ':'), use as-is
  if (shortId.includes(':')) return shortId

  // Resolve short ID (e.g. "TASK-130") by querying Neo4j id field directly
  const result = await svc.findByIdField(shortId)
  if (result) return result.uid

  throw new Error(`Node not found: ${shortId}`)
}

// ── Formatters ─────────────────────────────────────────────────────────────────

function formatNodeShort(node: GraphNode): string {
  return `${node.id} (${node.type}: ${node.title})`
}

function printTree(ctx: ContextResult): void {
  console.log(formatNodeShort(ctx.root))

  // Group edges by source being root
  const rootEdges = ctx.edges.filter(e => e.source === ctx.root.uid)
  const nodeMap = new Map<string, GraphNode>()
  for (const n of ctx.related) nodeMap.set(n.uid, n)

  for (let i = 0; i < rootEdges.length; i++) {
    const edge = rootEdges[i]
    const isLast = i === rootEdges.length - 1
    const prefix = isLast ? '└── ' : '├── '
    const childPrefix = isLast ? '    ' : '│   '
    const target = nodeMap.get(edge.target)
    const label = edge.relation.toUpperCase().replace(/-/g, '_')

    if (target) {
      console.log(`${prefix}${label} → ${formatNodeShort(target)}`)
      // Print sub-edges (edges from this target to other related nodes)
      printSubTree(ctx, target.uid, nodeMap, childPrefix, new Set([ctx.root.uid]))
    } else {
      console.log(`${prefix}${label} → ${edge.target} (not loaded)`)
    }
  }

  // Also show incoming edges
  const inEdges = ctx.edges.filter(e => e.target === ctx.root.uid)
  if (inEdges.length > 0) {
    for (let i = 0; i < inEdges.length; i++) {
      const edge = inEdges[i]
      const isLast = i === inEdges.length - 1
      const prefix = isLast ? '└── ' : '├── '
      const source = nodeMap.get(edge.source)
      const label = edge.relation.toUpperCase().replace(/-/g, '_')
      if (source) {
        console.log(`${prefix}← ${label} ← ${formatNodeShort(source)}`)
      }
    }
  }
}

function printSubTree(
  ctx: ContextResult,
  uid: string,
  nodeMap: Map<string, GraphNode>,
  indent: string,
  visited: Set<string>
): void {
  if (visited.has(uid)) return
  visited.add(uid)

  const subEdges = ctx.edges.filter(e => e.source === uid && !visited.has(e.target))
  for (let i = 0; i < subEdges.length; i++) {
    const edge = subEdges[i]
    const isLast = i === subEdges.length - 1
    const prefix = isLast ? '└── ' : '├── '
    const childPrefix = isLast ? '    ' : '│   '
    const target = nodeMap.get(edge.target)
    const label = edge.relation.toUpperCase().replace(/-/g, '_')

    if (target) {
      console.log(`${indent}${prefix}${label} → ${formatNodeShort(target)}`)
      printSubTree(ctx, target.uid, nodeMap, indent + childPrefix, visited)
    }
  }
}

function printTable(nodes: GraphNode[]): void {
  if (nodes.length === 0) {
    console.log('No results.')
    return
  }

  // Calculate column widths
  const headers = ['ID', 'Title', 'Status', 'Priority']
  const rows = nodes.map(n => [
    n.id,
    n.title.length > 40 ? n.title.slice(0, 37) + '...' : n.title,
    n.status || '-',
    n.priority || '-'
  ])

  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => r[i].length))
  )

  const sep = widths.map(w => '-'.repeat(w)).join('-+-')
  const fmtRow = (row: string[]): string =>
    row.map((cell, i) => cell.padEnd(widths[i])).join(' | ')

  console.log(fmtRow(headers))
  console.log(sep)
  for (const row of rows) {
    console.log(fmtRow(row))
  }
  console.log(`\n${nodes.length} result(s)`)
}

// ── Commands ───────────────────────────────────────────────────────────────────

const program = new Command()
program.name('graph').description('Graph CLI — query and manage the knowledge graph').version('0.1.0')

// context
program
  .command('context <id>')
  .description('Show context tree for a node')
  .option('-d, --depth <n>', 'traversal depth', '2')
  .option('-f, --format <fmt>', 'output format: tree | json', 'tree')
  .action(async (id: string, opts: { depth: string; format: string }) => {
    await withService(async (svc) => {
      const uid = await resolveUid(svc, id)
      const ctx = await svc.getContext(uid, parseInt(opts.depth))

      if (opts.format === 'json') {
        console.log(JSON.stringify(ctx, null, 2))
      } else {
        printTree(ctx)
      }
    })
  })

// list
program
  .command('list <type>')
  .description('List nodes by type (tasks, features, decisions, projects)')
  .option('-p, --project <name>', 'filter by project')
  .option('-s, --status <status>', 'filter by status')
  .option('--priority <priority>', 'filter by priority')
  .option('-q, --query <text>', 'search in title')
  .option('-l, --limit <n>', 'max results')
  .option('-f, --format <fmt>', 'output format: table | json', 'table')
  .action(async (type: string, opts: {
    project?: string
    status?: string
    priority?: string
    query?: string
    limit?: string
    format: string
  }) => {
    await withService(async (svc) => {
      // Normalize type: "tasks" → "task"
      const typeMap: Record<string, NodeType> = {
        task: NodeType.Task, tasks: NodeType.Task,
        feature: NodeType.Feature, features: NodeType.Feature,
        decision: NodeType.Decision, decisions: NodeType.Decision,
        project: NodeType.Project, projects: NodeType.Project
      }
      const nodeType = typeMap[type.toLowerCase()]
      if (!nodeType) {
        console.error(`Unknown type: ${type}. Use: tasks, features, decisions, projects`)
        process.exit(1)
      }

      const nodes = await svc.findNodes({
        type: nodeType,
        project: opts.project,
        status: opts.status,
        priority: opts.priority,
        query: opts.query,
        limit: opts.limit ? parseInt(opts.limit) : undefined
      })

      if (opts.format === 'json') {
        console.log(JSON.stringify(nodes, null, 2))
      } else {
        printTable(nodes)
      }
    })
  })

// info
program
  .command('info <id>')
  .description('Show node details')
  .option('-f, --format <fmt>', 'output format: text | json', 'text')
  .action(async (id: string, opts: { format: string }) => {
    await withService(async (svc) => {
      const uid = await resolveUid(svc, id)
      const node = await svc.getNode(uid)
      if (!node) {
        console.error(`Node not found: ${uid}`)
        process.exit(1)
      }

      const outEdges = await svc.getRelationships(uid, 'out')
      const inEdges = await svc.getRelationships(uid, 'in')

      if (opts.format === 'json') {
        console.log(JSON.stringify({ node, outEdges, inEdges }, null, 2))
      } else {
        console.log(`UID:      ${node.uid}`)
        console.log(`Type:     ${node.type}`)
        console.log(`Title:    ${node.title}`)
        console.log(`Project:  ${node.project}`)
        console.log(`Status:   ${node.status || '-'}`)
        console.log(`Priority: ${node.priority || '-'}`)
        console.log(`Relationships: ${outEdges.length} out, ${inEdges.length} in`)
      }
    })
  })

// create
program
  .command('create <type>')
  .description('Create a new node')
  .requiredOption('-p, --project <name>', 'project name')
  .requiredOption('-t, --title <title>', 'node title')
  .option('--id <id>', 'node ID (auto-generated if omitted)')
  .option('-s, --status <status>', 'status')
  .option('--priority <priority>', 'priority')
  .action(async (type: string, opts: {
    project: string
    title: string
    id?: string
    status?: string
    priority?: string
  }) => {
    await withService(async (svc) => {
      const typeMap: Record<string, NodeType> = {
        task: NodeType.Task, feature: NodeType.Feature,
        decision: NodeType.Decision, project: NodeType.Project
      }
      const nodeType = typeMap[type.toLowerCase()]
      if (!nodeType) {
        console.error(`Unknown type: ${type}. Use: task, feature, decision, project`)
        process.exit(1)
      }

      const id = opts.id || `${type.toUpperCase()}-${Date.now()}`
      const node = await svc.createNode({
        type: nodeType,
        project: opts.project,
        id,
        title: opts.title,
        status: opts.status,
        priority: opts.priority
      })
      console.log(`Created ${node.uid} (${node.title})`)
    })
  })

// link
program
  .command('link <source> <target> <relation>')
  .description('Create a relationship between two nodes')
  .action(async (source: string, target: string, relation: string) => {
    await withService(async (svc) => {
      const sourceUid = await resolveUid(svc, source)
      const targetUid = await resolveUid(svc, target)

      const relMap: Record<string, RelationType> = {
        depends_on: RelationType.DependsOn, 'depends-on': RelationType.DependsOn,
        blocks: RelationType.Blocks,
        part_of: RelationType.PartOf, 'part-of': RelationType.PartOf,
        relates_to: RelationType.RelatesTo, 'relates-to': RelationType.RelatesTo,
        implements: RelationType.Implements,
        decided_by: RelationType.DecidedBy, 'decided-by': RelationType.DecidedBy
      }
      const rel = relMap[relation.toLowerCase()]
      if (!rel) {
        console.error(`Unknown relation: ${relation}. Use: ${Object.keys(relMap).join(', ')}`)
        process.exit(1)
      }

      await svc.createRelationship(sourceUid, targetUid, rel)
      console.log(`Linked ${source} → ${target} (${relation})`)
    })
  })

// unlink
program
  .command('unlink <source> <target> <relation>')
  .description('Remove a relationship between two nodes')
  .action(async (source: string, target: string, relation: string) => {
    await withService(async (svc) => {
      const sourceUid = await resolveUid(svc, source)
      const targetUid = await resolveUid(svc, target)

      const relMap: Record<string, RelationType> = {
        depends_on: RelationType.DependsOn, 'depends-on': RelationType.DependsOn,
        blocks: RelationType.Blocks,
        part_of: RelationType.PartOf, 'part-of': RelationType.PartOf,
        relates_to: RelationType.RelatesTo, 'relates-to': RelationType.RelatesTo,
        implements: RelationType.Implements,
        decided_by: RelationType.DecidedBy, 'decided-by': RelationType.DecidedBy
      }
      const rel = relMap[relation.toLowerCase()]
      if (!rel) {
        console.error(`Unknown relation: ${relation}`)
        process.exit(1)
      }

      await svc.deleteRelationship(sourceUid, targetUid, rel)
      console.log(`Unlinked ${source} → ${target} (${relation})`)
    })
  })

// workspace project management (projects.json)
const workspace = program.command('workspace').description('Manage workspace projects (projects.json)')

function getProjectsJsonPath(): string {
  return path.resolve(process.cwd(), 'projects.json')
}

interface WorkspaceProject {
  id: string
  cwd: string
  shell?: string
}

function loadWorkspaceProjects(): WorkspaceProject[] {
  const p = getProjectsJsonPath()
  if (!fs.existsSync(p)) return []
  return JSON.parse(fs.readFileSync(p, 'utf-8'))
}

function saveWorkspaceProjects(projects: WorkspaceProject[]): void {
  fs.writeFileSync(getProjectsJsonPath(), JSON.stringify(projects, null, 2), 'utf-8')
}

workspace
  .command('list')
  .description('List workspace projects')
  .action(() => {
    const projects = loadWorkspaceProjects()
    if (projects.length === 0) {
      console.log('No projects. Use `graph workspace add` to add one.')
      return
    }
    for (const p of projects) {
      console.log(`${p.id}  ${p.cwd}`)
    }
  })

workspace
  .command('add <id> <cwd>')
  .description('Add a project to the workspace')
  .action((id: string, cwd: string) => {
    const projects = loadWorkspaceProjects()
    if (projects.some(p => p.id === id)) {
      console.error(`Project "${id}" already exists`)
      process.exit(1)
    }
    const resolved = path.resolve(cwd)
    if (!fs.existsSync(resolved)) {
      console.error(`Path not found: ${resolved}`)
      process.exit(1)
    }
    projects.push({ id, cwd: resolved })
    saveWorkspaceProjects(projects)
    console.log(`Added ${id} (${resolved})`)
  })

workspace
  .command('remove <id>')
  .description('Remove a project from the workspace')
  .action((id: string) => {
    const projects = loadWorkspaceProjects()
    const idx = projects.findIndex(p => p.id === id)
    if (idx === -1) {
      console.error(`Project "${id}" not found`)
      process.exit(1)
    }
    projects.splice(idx, 1)
    saveWorkspaceProjects(projects)
    console.log(`Removed ${id}`)
  })

// ── Run ────────────────────────────────────────────────────────────────────────

program.parseAsync(process.argv).catch(err => {
  console.error(err.message || err)
  process.exit(1)
})
