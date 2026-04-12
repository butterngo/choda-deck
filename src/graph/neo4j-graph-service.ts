/**
 * Neo4jGraphService — full GraphService implementation backed by Neo4j
 */

import neo4j, { Driver, Session } from 'neo4j-driver'
import {
  NodeType,
  RelationType,
  buildUid,
  type Uid,
  type GraphNode,
  type GraphEdge,
  type ContextResult
} from './graph-types'
import type {
  GraphService,
  CreateNodeInput,
  UpdateNodeInput,
  FindNodesFilter,
  ImportBatchInput,
  ImportBatchResult
} from './graph-service.interface'
import { registerGraphProvider, type Neo4jProviderConfig } from './graph-config'

// ── Helpers ────────────────────────────────────────────────────────────────────

function recordToGraphNode(record: Record<string, unknown>): GraphNode {
  return {
    uid: record.uid as string,
    type: record.type as NodeType,
    project: record.project as string,
    id: record.id as string,
    title: record.title as string,
    status: (record.status as string) || undefined,
    priority: (record.priority as string) || undefined,
    labels: record.labels ? (record.labels as string[]) : undefined,
    createdAt: record.createdAt as string,
    updatedAt: record.updatedAt as string
  }
}

function now(): string {
  return new Date().toISOString()
}

// ── Implementation ─────────────────────────────────────────────────────────────

export class Neo4jGraphService implements GraphService {
  private driver: Driver
  private database: string | undefined

  constructor(config: Neo4jProviderConfig) {
    this.driver = neo4j.driver(
      config.uri,
      neo4j.auth.basic(config.username, config.password)
    )
    this.database = config.database
  }

  async connect(): Promise<void> {
    await this.driver.verifyConnectivity()
  }

  async disconnect(): Promise<void> {
    await this.driver.close()
  }

  private readSession(): Session {
    return this.driver.session({
      database: this.database,
      defaultAccessMode: neo4j.session.READ
    })
  }

  private writeSession(): Session {
    return this.driver.session({
      database: this.database,
      defaultAccessMode: neo4j.session.WRITE
    })
  }

  // ── Node operations ────────────────────────────────────────────────────────

  async createNode(input: CreateNodeInput): Promise<GraphNode> {
    const uid = buildUid(input.type, input.project, input.id)
    const ts = now()
    const session = this.writeSession()
    try {
      const result = await session.run(
        `CREATE (n:GraphNode {
           uid: $uid, type: $type, project: $project, id: $id,
           title: $title, status: $status, priority: $priority,
           labels: $labels, createdAt: $ts, updatedAt: $ts
         })
         RETURN properties(n) AS props`,
        {
          uid,
          type: input.type,
          project: input.project,
          id: input.id,
          title: input.title,
          status: input.status || null,
          priority: input.priority || null,
          labels: input.labels || [],
          ts
        }
      )
      return recordToGraphNode(result.records[0].get('props'))
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        err.message.includes('already exists')
      ) {
        throw new Error(`Node already exists: ${uid}`)
      }
      throw err
    } finally {
      await session.close()
    }
  }

  async updateNode(uid: Uid, input: UpdateNodeInput): Promise<GraphNode> {
    const session = this.writeSession()
    try {
      const setClauses: string[] = ['n.updatedAt = $ts']
      const params: Record<string, unknown> = { uid, ts: now() }

      if (input.title !== undefined) {
        setClauses.push('n.title = $title')
        params.title = input.title
      }
      if (input.status !== undefined) {
        setClauses.push('n.status = $status')
        params.status = input.status
      }
      if (input.priority !== undefined) {
        setClauses.push('n.priority = $priority')
        params.priority = input.priority
      }
      if (input.labels !== undefined) {
        setClauses.push('n.labels = $labels')
        params.labels = input.labels
      }

      const result = await session.run(
        `MATCH (n:GraphNode { uid: $uid })
         SET ${setClauses.join(', ')}
         RETURN properties(n) AS props`,
        params
      )

      if (result.records.length === 0) {
        throw new Error(`Node not found: ${uid}`)
      }
      return recordToGraphNode(result.records[0].get('props'))
    } finally {
      await session.close()
    }
  }

  async findByIdField(id: string): Promise<GraphNode | null> {
    const session = this.readSession()
    try {
      const result = await session.run(
        'MATCH (n:GraphNode) WHERE toLower(n.id) = toLower($id) RETURN properties(n) AS props LIMIT 1',
        { id }
      )
      if (result.records.length === 0) return null
      return recordToGraphNode(result.records[0].get('props'))
    } finally {
      await session.close()
    }
  }

  async deleteNode(uid: Uid): Promise<void> {
    const session = this.writeSession()
    try {
      await session.run(
        'MATCH (n:GraphNode { uid: $uid }) DETACH DELETE n',
        { uid }
      )
    } finally {
      await session.close()
    }
  }

  async getNode(uid: Uid): Promise<GraphNode | null> {
    const session = this.readSession()
    try {
      const result = await session.run(
        'MATCH (n:GraphNode { uid: $uid }) RETURN properties(n) AS props',
        { uid }
      )
      if (result.records.length === 0) return null
      return recordToGraphNode(result.records[0].get('props'))
    } finally {
      await session.close()
    }
  }

  async findNodes(filter: FindNodesFilter): Promise<GraphNode[]> {
    const session = this.readSession()
    try {
      const whereClauses: string[] = []
      const params: Record<string, unknown> = {}

      if (filter.type) {
        whereClauses.push('n.type = $type')
        params.type = filter.type
      }
      if (filter.project) {
        whereClauses.push('n.project = $project')
        params.project = filter.project
      }
      if (filter.status) {
        whereClauses.push('n.status = $status')
        params.status = filter.status
      }
      if (filter.priority) {
        whereClauses.push('n.priority = $priority')
        params.priority = filter.priority
      }
      if (filter.label) {
        whereClauses.push('$label IN n.labels')
        params.label = filter.label
      }
      if (filter.query) {
        whereClauses.push('toLower(n.title) CONTAINS toLower($query)')
        params.query = filter.query
      }

      const where = whereClauses.length > 0
        ? `WHERE ${whereClauses.join(' AND ')}`
        : ''
      const limit = filter.limit ? `LIMIT $limit` : ''
      if (filter.limit) params.limit = neo4j.int(filter.limit)

      const result = await session.run(
        `MATCH (n:GraphNode) ${where} RETURN properties(n) AS props ${limit}`,
        params
      )
      return result.records.map(r => recordToGraphNode(r.get('props')))
    } finally {
      await session.close()
    }
  }

  // ── Relationship operations ────────────────────────────────────────────────

  async createRelationship(
    sourceUid: Uid,
    targetUid: Uid,
    relation: RelationType,
    properties?: Record<string, unknown>
  ): Promise<GraphEdge> {
    const session = this.writeSession()
    try {
      const result = await session.run(
        `MATCH (src:GraphNode { uid: $sourceUid })
         MATCH (tgt:GraphNode { uid: $targetUid })
         CREATE (src)-[r:RELATES_TO { relation: $relation }]->(tgt)
         SET r += $props
         RETURN src.uid AS source, tgt.uid AS target, r.relation AS relation`,
        {
          sourceUid,
          targetUid,
          relation,
          props: properties || {}
        }
      )
      if (result.records.length === 0) {
        throw new Error(`Could not create relationship: source or target not found`)
      }
      const rec = result.records[0]
      return {
        source: rec.get('source'),
        target: rec.get('target'),
        relation: rec.get('relation') as RelationType,
        properties
      }
    } finally {
      await session.close()
    }
  }

  async deleteRelationship(
    sourceUid: Uid,
    targetUid: Uid,
    relation: RelationType
  ): Promise<void> {
    const session = this.writeSession()
    try {
      await session.run(
        `MATCH (src:GraphNode { uid: $sourceUid })-[r:RELATES_TO { relation: $relation }]->(tgt:GraphNode { uid: $targetUid })
         DELETE r`,
        { sourceUid, targetUid, relation }
      )
    } finally {
      await session.close()
    }
  }

  async getRelationships(
    uid: Uid,
    direction: 'in' | 'out' | 'both' = 'both'
  ): Promise<GraphEdge[]> {
    const session = this.readSession()
    try {
      let pattern: string
      if (direction === 'out') {
        pattern = '(n)-[r:RELATES_TO]->(other)'
      } else if (direction === 'in') {
        pattern = '(n)<-[r:RELATES_TO]-(other)'
      } else {
        pattern = '(n)-[r:RELATES_TO]-(other)'
      }

      const result = await session.run(
        `MATCH (n:GraphNode { uid: $uid })
         MATCH ${pattern}
         RETURN startNode(r).uid AS source, endNode(r).uid AS target, r.relation AS relation`,
        { uid }
      )
      return result.records.map(rec => ({
        source: rec.get('source'),
        target: rec.get('target'),
        relation: rec.get('relation') as RelationType
      }))
    } finally {
      await session.close()
    }
  }

  // ── Context query ──────────────────────────────────────────────────────────

  async getContext(uid: Uid, depth = 1): Promise<ContextResult> {
    const session = this.readSession()
    try {
      const result = await session.run(
        `MATCH (root:GraphNode { uid: $uid })
         OPTIONAL MATCH path = (root)-[*1..${depth}]-(related:GraphNode)
         WITH root, collect(DISTINCT related) AS relatedNodes,
              collect(DISTINCT relationships(path)) AS allRels
         RETURN properties(root) AS root,
                [r IN relatedNodes | properties(r)] AS related,
                allRels`,
        { uid }
      )

      if (result.records.length === 0) {
        throw new Error(`Node not found: ${uid}`)
      }

      const rec = result.records[0]
      const root = recordToGraphNode(rec.get('root'))
      const related = (rec.get('related') as Record<string, unknown>[])
        .map(recordToGraphNode)

      // Flatten relationship arrays and deduplicate
      const seenEdges = new Set<string>()
      const edges: GraphEdge[] = []
      const allRels = rec.get('allRels') as unknown[][]
      for (const relArray of allRels) {
        if (!relArray) continue
        for (const rel of relArray) {
          const r = rel as { start: unknown; end: unknown; properties: Record<string, unknown> }
          // Neo4j relationships need resolving via a different approach
          // Use a simpler query instead
        }
      }

      // Simpler approach: separate query for edges
      const edgeResult = await session.run(
        `MATCH (root:GraphNode { uid: $uid })
         MATCH (root)-[*0..${depth}]-(n:GraphNode)
         WITH collect(DISTINCT n) AS nodes
         UNWIND nodes AS a
         MATCH (a)-[r:RELATES_TO]->(b)
         WHERE b IN nodes
         RETURN DISTINCT a.uid AS source, b.uid AS target, r.relation AS relation`,
        { uid }
      )

      for (const edgeRec of edgeResult.records) {
        const key = `${edgeRec.get('source')}-${edgeRec.get('relation')}-${edgeRec.get('target')}`
        if (!seenEdges.has(key)) {
          seenEdges.add(key)
          edges.push({
            source: edgeRec.get('source'),
            target: edgeRec.get('target'),
            relation: edgeRec.get('relation') as RelationType
          })
        }
      }

      return { root, related, edges }
    } finally {
      await session.close()
    }
  }

  // ── Bulk operations ────────────────────────────────────────────────────────

  async importBatch(input: ImportBatchInput): Promise<ImportBatchResult> {
    const session = this.writeSession()
    const errors: string[] = []
    let nodesCreated = 0
    let edgesCreated = 0

    try {
      // Batch nodes
      const BATCH = 500
      for (let i = 0; i < input.nodes.length; i += BATCH) {
        const batch = input.nodes.slice(i, i + BATCH).map(n => ({
          uid: buildUid(n.type, n.project, n.id),
          type: n.type,
          project: n.project,
          id: n.id,
          title: n.title,
          status: n.status || null,
          priority: n.priority || null,
          labels: n.labels || [],
          ts: now()
        }))

        const result = await session.run(
          `UNWIND $batch AS n
           MERGE (node:GraphNode { uid: n.uid })
           ON CREATE SET
             node.type = n.type, node.project = n.project, node.id = n.id,
             node.title = n.title, node.status = n.status, node.priority = n.priority,
             node.labels = n.labels, node.createdAt = n.ts, node.updatedAt = n.ts,
             node._created = true
           ON MATCH SET
             node.title = n.title, node.status = n.status, node.priority = n.priority,
             node.labels = n.labels, node.updatedAt = n.ts,
             node._created = false
           WITH node, node._created AS wasCreated
           REMOVE node._created
           RETURN wasCreated`,
          { batch }
        )
        nodesCreated += result.records.filter(r => r.get('wasCreated') === true).length
      }

      // Batch edges
      for (let i = 0; i < input.edges.length; i += BATCH) {
        const batch = input.edges.slice(i, i + BATCH)
        const result = await session.run(
          `UNWIND $batch AS e
           MATCH (src:GraphNode { uid: e.sourceUid })
           MATCH (tgt:GraphNode { uid: e.targetUid })
           MERGE (src)-[r:RELATES_TO { relation: e.relation }]->(tgt)
           ON CREATE SET r.createdAt = datetime(), r._created = true
           ON MATCH SET r._created = false
           WITH r, r._created AS wasCreated
           REMOVE r._created
           RETURN wasCreated`,
          { batch }
        )
        edgesCreated += result.records.filter(r => r.get('wasCreated') === true).length
      }
    } catch (err: unknown) {
      errors.push(err instanceof Error ? err.message : String(err))
    } finally {
      await session.close()
    }

    return { nodesCreated, edgesCreated, errors }
  }
}

// ── Register provider ──────────────────────────────────────────────────────────

registerGraphProvider('neo4j', (config) => {
  return new Neo4jGraphService(config as Neo4jProviderConfig)
})
