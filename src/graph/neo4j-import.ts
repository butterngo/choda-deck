#!/usr/bin/env ts-node
/**
 * Neo4j Import — read vault-graph.json, MERGE into Neo4j (idempotent)
 * Usage: npx ts-node src/graph/neo4j-import.ts --input vault-graph.json
 */

import * as fs from 'fs'
import * as path from 'path'
import neo4j, { Driver, Session } from 'neo4j-driver'
import type { GraphNode, GraphEdge } from './graph-types'

// ── Types ──────────────────────────────────────────────────────────────────────

interface VaultGraphJson {
  nodes: GraphNode[]
  edges: GraphEdge[]
  summary: unknown
}

interface ImportStats {
  nodesCreated: number
  nodesSkipped: number
  edgesCreated: number
  edgesSkipped: number
  edgeWarnings: string[]
}

// ── Config ─────────────────────────────────────────────────────────────────────

const NEO4J_URI = process.env.NEO4J_URI || 'bolt://localhost:7687'
const NEO4J_USER = process.env.NEO4J_USER || 'neo4j'
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || 'neo4j'
const BATCH_SIZE = 500

// ── Schema ─────────────────────────────────────────────────────────────────────

async function ensureSchema(session: Session): Promise<void> {
  // Unique constraint on uid (also creates index)
  await session.run(
    'CREATE CONSTRAINT node_uid_unique IF NOT EXISTS FOR (n:GraphNode) REQUIRE n.uid IS UNIQUE'
  )
  // Indexes for common queries
  await session.run(
    'CREATE INDEX node_type_idx IF NOT EXISTS FOR (n:GraphNode) ON (n.type)'
  )
  await session.run(
    'CREATE INDEX node_status_idx IF NOT EXISTS FOR (n:GraphNode) ON (n.status)'
  )
  await session.run(
    'CREATE INDEX node_project_idx IF NOT EXISTS FOR (n:GraphNode) ON (n.project)'
  )
  console.log('Schema constraints and indexes ensured.')
}

// ── Import nodes ───────────────────────────────────────────────────────────────

async function importNodes(
  session: Session,
  nodes: GraphNode[]
): Promise<{ created: number; skipped: number }> {
  let created = 0
  let skipped = 0

  for (let i = 0; i < nodes.length; i += BATCH_SIZE) {
    const batch = nodes.slice(i, i + BATCH_SIZE)
    const result = await session.run(
      `UNWIND $batch AS n
       MERGE (node:GraphNode { uid: n.uid })
       ON CREATE SET
         node.type = n.type,
         node.project = n.project,
         node.id = n.id,
         node.title = n.title,
         node.status = n.status,
         node.priority = n.priority,
         node.labels = n.labels,
         node.createdAt = n.createdAt,
         node.updatedAt = n.updatedAt,
         node._created = true
       ON MATCH SET
         node.title = n.title,
         node.status = n.status,
         node.priority = n.priority,
         node.labels = n.labels,
         node.updatedAt = n.updatedAt,
         node._created = false
       WITH node
       WITH node, node._created AS wasCreated
       REMOVE node._created
       RETURN wasCreated AS action`,
      { batch }
    )

    for (const record of result.records) {
      if (record.get('action') === true) {
        created++
      } else {
        skipped++
      }
    }

    console.log(`  Nodes batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} processed`)
  }

  return { created, skipped }
}

// ── Import edges ───────────────────────────────────────────────────────────────

async function importEdges(
  session: Session,
  edges: GraphEdge[],
  nodeUids: Set<string>
): Promise<{ created: number; skipped: number; warnings: string[] }> {
  let created = 0
  let skipped = 0
  const warnings: string[] = []

  // Filter out edges referencing non-existent nodes
  const validEdges: GraphEdge[] = []
  for (const edge of edges) {
    if (!nodeUids.has(edge.source)) {
      warnings.push(`skip edge: source not found ${edge.source} → ${edge.target}`)
      continue
    }
    if (!nodeUids.has(edge.target)) {
      warnings.push(`skip edge: target not found ${edge.source} → ${edge.target}`)
      continue
    }
    validEdges.push(edge)
  }

  for (let i = 0; i < validEdges.length; i += BATCH_SIZE) {
    const batch = validEdges.slice(i, i + BATCH_SIZE)
    const result = await session.run(
      `UNWIND $batch AS e
       MATCH (src:GraphNode { uid: e.source })
       MATCH (tgt:GraphNode { uid: e.target })
       MERGE (src)-[r:RELATES_TO { relation: e.relation }]->(tgt)
       ON CREATE SET r.createdAt = datetime()
       RETURN
         CASE WHEN r.createdAt = datetime() THEN 'created' ELSE 'matched' END AS action`,
      { batch }
    )

    for (const record of result.records) {
      if (record.get('action') === 'created') {
        created++
      } else {
        skipped++
      }
    }

    console.log(`  Edges batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} processed`)
  }

  return { created, skipped, warnings }
}

// ── CLI ────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const inputIdx = args.indexOf('--input')
  if (inputIdx === -1 || !args[inputIdx + 1]) {
    console.error('Usage: npx ts-node src/graph/neo4j-import.ts --input vault-graph.json')
    process.exit(1)
  }

  const inputPath = path.resolve(args[inputIdx + 1])
  if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`)
    process.exit(1)
  }

  const data: VaultGraphJson = JSON.parse(fs.readFileSync(inputPath, 'utf-8'))
  console.log(`Input: ${data.nodes.length} nodes, ${data.edges.length} edges`)

  const nodeUids = new Set(data.nodes.map(n => n.uid))

  const driver: Driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD))
  const session: Session = driver.session()

  try {
    console.log(`\nConnecting to ${NEO4J_URI}...`)
    await driver.verifyConnectivity()
    console.log('Connected.\n')

    // Schema
    await ensureSchema(session)

    // Nodes
    console.log('\nImporting nodes...')
    const nodeStats = await importNodes(session, data.nodes)

    // Edges
    console.log('\nImporting edges...')
    const edgeStats = await importEdges(session, data.edges, nodeUids)

    // Summary
    const stats: ImportStats = {
      nodesCreated: nodeStats.created,
      nodesSkipped: nodeStats.skipped,
      edgesCreated: edgeStats.created,
      edgesSkipped: edgeStats.skipped,
      edgeWarnings: edgeStats.warnings
    }

    console.log('\n── Summary ──')
    console.log(`Nodes: Created ${stats.nodesCreated}, Skipped ${stats.nodesSkipped} (existing)`)
    console.log(`Edges: Created ${stats.edgesCreated}, Skipped ${stats.edgesSkipped} (existing)`)

    if (stats.edgeWarnings.length > 0) {
      console.log(`\n⚠ Edge warnings (${stats.edgeWarnings.length}):`)
      for (const w of stats.edgeWarnings) {
        console.log(`  ${w}`)
      }
    }
  } finally {
    await session.close()
    await driver.close()
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('Import failed:', err)
    process.exit(1)
  })
}

export { ensureSchema, importNodes, importEdges }
