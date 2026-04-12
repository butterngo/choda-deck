#!/usr/bin/env node
/**
 * MCP Graph Server — graph context tools for Claude
 * Usage: node mcp-graph-server.js (stdio transport)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js'
import { Neo4jGraphService } from './neo4j-graph-service'
import { NodeType, RelationType } from './graph-types'
import type { Neo4jProviderConfig } from './graph-config'
import * as fs from 'fs'
import * as path from 'path'

// ── Config ─────────────────────────────────────────────────────────────────────

const config: Neo4jProviderConfig = {
  provider: 'neo4j',
  uri: process.env.NEO4J_URI || 'bolt://localhost:7687',
  username: process.env.NEO4J_USER || 'neo4j',
  password: process.env.NEO4J_PASSWORD || 'yourpassword'
}

const VAULT_PATH = process.env.VAULT_PATH || 'C:/Users/hngo1_mantu/vault'
const MAX_CONTENT_LINES = 200
const MAX_CONTEXT_NODES = 10

// ── Helpers ────────────────────────────────────────────────────────────────────

function readNodeContent(node: { type: string; project: string; id: string }): string | null {
  const pathMap: Record<string, string> = {
    task: `10-Projects/${node.project}/tasks`,
    feature: `10-Projects/${node.project}/features`,
    decision: `10-Projects/${node.project}/docs/decisions`
  }

  const dir = pathMap[node.type]
  if (!dir) return null

  const baseDir = path.join(VAULT_PATH, dir)
  if (!fs.existsSync(baseDir)) return null

  // Find file matching node id
  try {
    const files = fs.readdirSync(baseDir)
    const match = files.find(f =>
      f.toLowerCase().startsWith(node.id.toLowerCase())
    )
    if (!match) return null

    const content = fs.readFileSync(path.join(baseDir, match), 'utf-8')
    const lines = content.split('\n')
    if (lines.length > MAX_CONTENT_LINES) {
      return lines.slice(0, MAX_CONTENT_LINES).join('\n') + '\n\n... (truncated)'
    }
    return content
  } catch {
    return null
  }
}

let svc: Neo4jGraphService | null = null

async function getService(): Promise<Neo4jGraphService> {
  if (!svc) {
    svc = new Neo4jGraphService(config)
    await svc.connect()
  }
  return svc
}

async function resolveUid(service: Neo4jGraphService, shortId: string): Promise<string> {
  if (shortId.includes(':')) return shortId
  const node = await service.findByIdField(shortId)
  if (node) return node.uid
  throw new Error(`Node not found: ${shortId}`)
}

// ── MCP Server ─────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'choda-graph', version: '0.1.0' },
  { capabilities: { tools: {} } }
)

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'graph_context',
      description: 'Get context subgraph for a node — returns root node, related nodes with .md content, and edges. Use when analyzing tasks, features, or decisions.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          nodeId: { type: 'string', description: 'Node ID (e.g. TASK-130, F-16, adr-007) or full UID' },
          depth: { type: 'number', description: 'Traversal depth (default: 2)', default: 2 }
        },
        required: ['nodeId']
      }
    },
    {
      name: 'graph_list',
      description: 'List nodes filtered by type, project, status. Lightweight — no file content.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          type: { type: 'string', description: 'Node type: task, feature, decision, project' },
          project: { type: 'string', description: 'Project name filter' },
          status: { type: 'string', description: 'Status filter (e.g. open, done, archived)' },
          query: { type: 'string', description: 'Search in title' },
          limit: { type: 'number', description: 'Max results (default: 20)', default: 20 }
        }
      }
    },
    {
      name: 'graph_search',
      description: 'Search nodes by text across all types. Matches against title.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Search text' },
          limit: { type: 'number', description: 'Max results (default: 10)', default: 10 }
        },
        required: ['query']
      }
    },
    {
      name: 'graph_create_node',
      description: 'Create a new node in the graph.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          type: { type: 'string', description: 'Node type: task, feature, decision' },
          project: { type: 'string', description: 'Project name' },
          id: { type: 'string', description: 'Node ID (e.g. TASK-135)' },
          title: { type: 'string', description: 'Node title' },
          status: { type: 'string', description: 'Status (default: open)' },
          priority: { type: 'string', description: 'Priority (e.g. high, medium, low)' }
        },
        required: ['type', 'project', 'id', 'title']
      }
    },
    {
      name: 'graph_create_relationship',
      description: 'Create a relationship between two nodes.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          from: { type: 'string', description: 'Source node ID or UID' },
          to: { type: 'string', description: 'Target node ID or UID' },
          relation: { type: 'string', description: 'Relation type: depends-on, implements, part-of, relates-to, decided-by' }
        },
        required: ['from', 'to', 'relation']
      }
    }
  ]
}))

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  try {
    const service = await getService()

    switch (name) {
      case 'graph_context': {
        const nodeId = args?.nodeId as string
        const depth = (args?.depth as number) || 2
        const uid = await resolveUid(service, nodeId)
        const ctx = await service.getContext(uid, depth)

        // Enrich with file content, cap at MAX_CONTEXT_NODES
        const related = ctx.related.slice(0, MAX_CONTEXT_NODES).map(node => ({
          ...node,
          content: readNodeContent(node)
        }))

        const result = {
          root: { ...ctx.root, content: readNodeContent(ctx.root) },
          related,
          edges: ctx.edges,
          summary: `${related.length} related nodes, ${ctx.edges.length} edges`
        }

        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      }

      case 'graph_list': {
        const typeMap: Record<string, NodeType> = {
          task: NodeType.Task, feature: NodeType.Feature,
          decision: NodeType.Decision, project: NodeType.Project
        }
        const nodeType = args?.type ? typeMap[(args.type as string).toLowerCase()] : undefined
        const nodes = await service.findNodes({
          type: nodeType,
          project: args?.project as string,
          status: args?.status as string,
          query: args?.query as string,
          limit: (args?.limit as number) || 20
        })

        const result = nodes.map(n => ({
          uid: n.uid, id: n.id, title: n.title,
          status: n.status, priority: n.priority, project: n.project
        }))

        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      }

      case 'graph_search': {
        const query = args?.query as string
        const limit = (args?.limit as number) || 10
        const nodes = await service.findNodes({ query, limit })

        const result = nodes.map(n => ({
          uid: n.uid, id: n.id, type: n.type, title: n.title,
          status: n.status, project: n.project
        }))

        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      }

      case 'graph_create_node': {
        const typeMap: Record<string, NodeType> = {
          task: NodeType.Task, feature: NodeType.Feature,
          decision: NodeType.Decision, project: NodeType.Project
        }
        const nodeType = typeMap[(args?.type as string).toLowerCase()]
        if (!nodeType) {
          return { content: [{ type: 'text', text: `Unknown type: ${args?.type}` }], isError: true }
        }

        const node = await service.createNode({
          type: nodeType,
          project: args?.project as string,
          id: args?.id as string,
          title: args?.title as string,
          status: (args?.status as string) || 'open',
          priority: args?.priority as string
        })

        return { content: [{ type: 'text', text: `Created ${node.uid} (${node.title})` }] }
      }

      case 'graph_create_relationship': {
        const fromUid = await resolveUid(service, args?.from as string)
        const toUid = await resolveUid(service, args?.to as string)

        const relMap: Record<string, RelationType> = {
          'depends-on': RelationType.DependsOn, 'depends_on': RelationType.DependsOn,
          blocks: RelationType.Blocks,
          'part-of': RelationType.PartOf, 'part_of': RelationType.PartOf,
          'relates-to': RelationType.RelatesTo, 'relates_to': RelationType.RelatesTo,
          implements: RelationType.Implements,
          'decided-by': RelationType.DecidedBy, 'decided_by': RelationType.DecidedBy
        }
        const rel = relMap[(args?.relation as string).toLowerCase()]
        if (!rel) {
          return { content: [{ type: 'text', text: `Unknown relation: ${args?.relation}` }], isError: true }
        }

        const edge = await service.createRelationship(fromUid, toUid, rel)
        return { content: [{ type: 'text', text: `Linked ${edge.source} → ${edge.target} (${edge.relation})` }] }
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true }
  }
})

// ── Start ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  console.error('MCP server failed:', err)
  process.exit(1)
})
