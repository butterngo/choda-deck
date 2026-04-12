import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Neo4jGraphService } from './neo4j-graph-service'
import { NodeType, RelationType, buildUid } from './graph-types'
import type { Neo4jProviderConfig } from './graph-config'

const TEST_PROJECT = '__test__'

const config: Neo4jProviderConfig = {
  provider: 'neo4j',
  uri: process.env.NEO4J_URI || 'bolt://localhost:7687',
  username: process.env.NEO4J_USER || 'neo4j',
  password: process.env.NEO4J_PASSWORD || 'yourpassword'
}

describe('Neo4jGraphService', () => {
  let svc: Neo4jGraphService

  beforeAll(async () => {
    svc = new Neo4jGraphService(config)
    await svc.connect()

    // Clean up test data from previous runs
    const existing = await svc.findNodes({ project: TEST_PROJECT })
    for (const node of existing) {
      await svc.deleteNode(node.uid)
    }
  })

  afterAll(async () => {
    // Cleanup
    const remaining = await svc.findNodes({ project: TEST_PROJECT })
    for (const node of remaining) {
      await svc.deleteNode(node.uid)
    }
    await svc.disconnect()
  })

  // ── createNode + getNode ─────────────────────────────────────────────────

  it('createNode returns a GraphNode with correct uid', async () => {
    const node = await svc.createNode({
      type: NodeType.Task,
      project: TEST_PROJECT,
      id: 'TASK-T01',
      title: 'Test task 01',
      status: 'open',
      priority: 'high'
    })

    expect(node.uid).toBe(buildUid(NodeType.Task, TEST_PROJECT, 'TASK-T01'))
    expect(node.title).toBe('Test task 01')
    expect(node.status).toBe('open')
  })

  it('getNode returns the created node', async () => {
    const uid = buildUid(NodeType.Task, TEST_PROJECT, 'TASK-T01')
    const node = await svc.getNode(uid)
    expect(node).not.toBeNull()
    expect(node!.title).toBe('Test task 01')
  })

  it('getNode returns null for non-existent uid', async () => {
    const node = await svc.getNode('task:__test__/TASK-NOPE')
    expect(node).toBeNull()
  })

  it('createNode throws on duplicate uid', async () => {
    await expect(
      svc.createNode({
        type: NodeType.Task,
        project: TEST_PROJECT,
        id: 'TASK-T01',
        title: 'Duplicate',
        status: 'open'
      })
    ).rejects.toThrow('already exists')
  })

  // ── updateNode ───────────────────────────────────────────────────────────

  it('updateNode changes specified fields', async () => {
    const uid = buildUid(NodeType.Task, TEST_PROJECT, 'TASK-T01')
    const updated = await svc.updateNode(uid, { status: 'done', priority: 'low' })
    expect(updated.status).toBe('done')
    expect(updated.priority).toBe('low')
    expect(updated.title).toBe('Test task 01') // unchanged
  })

  it('updateNode throws for non-existent node', async () => {
    await expect(
      svc.updateNode('task:__test__/TASK-NOPE', { title: 'x' })
    ).rejects.toThrow('not found')
  })

  // ── findNodes ────────────────────────────────────────────────────────────

  it('findNodes filters by type + project + status', async () => {
    // Create a second task
    await svc.createNode({
      type: NodeType.Task,
      project: TEST_PROJECT,
      id: 'TASK-T02',
      title: 'Test task 02',
      status: 'open'
    })

    const openTasks = await svc.findNodes({
      type: NodeType.Task,
      project: TEST_PROJECT,
      status: 'open'
    })
    expect(openTasks.length).toBe(1)
    expect(openTasks[0].id).toBe('TASK-T02')

    const allTasks = await svc.findNodes({
      type: NodeType.Task,
      project: TEST_PROJECT
    })
    expect(allTasks.length).toBe(2)
  })

  it('findNodes supports query (title search)', async () => {
    const results = await svc.findNodes({
      project: TEST_PROJECT,
      query: 'task 02'
    })
    expect(results.length).toBe(1)
    expect(results[0].id).toBe('TASK-T02')
  })

  it('findNodes supports limit', async () => {
    const results = await svc.findNodes({
      project: TEST_PROJECT,
      limit: 1
    })
    expect(results.length).toBe(1)
  })

  // ── Relationships ────────────────────────────────────────────────────────

  it('createRelationship + getRelationships', async () => {
    // Create a feature to relate to
    await svc.createNode({
      type: NodeType.Feature,
      project: TEST_PROJECT,
      id: 'F-T01',
      title: 'Test feature'
    })

    const t01Uid = buildUid(NodeType.Task, TEST_PROJECT, 'TASK-T01')
    const fUid = buildUid(NodeType.Feature, TEST_PROJECT, 'F-T01')

    const edge = await svc.createRelationship(t01Uid, fUid, RelationType.Implements)
    expect(edge.source).toBe(t01Uid)
    expect(edge.target).toBe(fUid)
    expect(edge.relation).toBe(RelationType.Implements)

    // Get outgoing relationships
    const outEdges = await svc.getRelationships(t01Uid, 'out')
    expect(outEdges.some(e => e.target === fUid && e.relation === RelationType.Implements)).toBe(true)

    // Get incoming relationships on feature
    const inEdges = await svc.getRelationships(fUid, 'in')
    expect(inEdges.some(e => e.source === t01Uid)).toBe(true)
  })

  it('deleteRelationship removes the edge', async () => {
    const t01Uid = buildUid(NodeType.Task, TEST_PROJECT, 'TASK-T01')
    const fUid = buildUid(NodeType.Feature, TEST_PROJECT, 'F-T01')

    await svc.deleteRelationship(t01Uid, fUid, RelationType.Implements)

    const edges = await svc.getRelationships(t01Uid, 'out')
    expect(edges.some(e => e.target === fUid && e.relation === RelationType.Implements)).toBe(false)
  })

  // ── getContext ───────────────────────────────────────────────────────────

  it('getContext returns root + related at depth 1', async () => {
    const t01Uid = buildUid(NodeType.Task, TEST_PROJECT, 'TASK-T01')
    const t02Uid = buildUid(NodeType.Task, TEST_PROJECT, 'TASK-T02')

    // Create relationship for context
    await svc.createRelationship(t01Uid, t02Uid, RelationType.DependsOn)

    const ctx = await svc.getContext(t01Uid, 1)
    expect(ctx.root.uid).toBe(t01Uid)
    expect(ctx.related.some(n => n.uid === t02Uid)).toBe(true)
    expect(ctx.edges.some(
      e => e.source === t01Uid && e.target === t02Uid && e.relation === RelationType.DependsOn
    )).toBe(true)
  })

  it('getContext at depth 2 returns transitive nodes', async () => {
    const t02Uid = buildUid(NodeType.Task, TEST_PROJECT, 'TASK-T02')
    const fUid = buildUid(NodeType.Feature, TEST_PROJECT, 'F-T01')

    // T02 → F-T01
    await svc.createRelationship(t02Uid, fUid, RelationType.Implements)

    // Query from T01 at depth 2: T01 → T02 → F-T01
    const t01Uid = buildUid(NodeType.Task, TEST_PROJECT, 'TASK-T01')
    const ctx = await svc.getContext(t01Uid, 2)

    expect(ctx.related.some(n => n.uid === fUid)).toBe(true)
    expect(ctx.related.some(n => n.uid === t02Uid)).toBe(true)
  })

  it('getContext throws for non-existent node', async () => {
    await expect(svc.getContext('task:__test__/NOPE')).rejects.toThrow('not found')
  })

  // ── deleteNode ───────────────────────────────────────────────────────────

  it('deleteNode removes node and all relationships', async () => {
    const t02Uid = buildUid(NodeType.Task, TEST_PROJECT, 'TASK-T02')
    await svc.deleteNode(t02Uid)

    const node = await svc.getNode(t02Uid)
    expect(node).toBeNull()

    // Edges from/to T02 should also be gone
    const t01Uid = buildUid(NodeType.Task, TEST_PROJECT, 'TASK-T01')
    const edges = await svc.getRelationships(t01Uid, 'out')
    expect(edges.some(e => e.target === t02Uid)).toBe(false)
  })

  // ── importBatch ──────────────────────────────────────────────────────────

  it('importBatch creates nodes and edges in bulk', async () => {
    const result = await svc.importBatch({
      nodes: [
        { type: NodeType.Task, project: TEST_PROJECT, id: 'TASK-B01', title: 'Batch 01' },
        { type: NodeType.Task, project: TEST_PROJECT, id: 'TASK-B02', title: 'Batch 02' }
      ],
      edges: [
        {
          sourceUid: buildUid(NodeType.Task, TEST_PROJECT, 'TASK-B01'),
          targetUid: buildUid(NodeType.Task, TEST_PROJECT, 'TASK-B02'),
          relation: RelationType.DependsOn
        }
      ]
    })

    expect(result.nodesCreated).toBe(2)
    expect(result.edgesCreated).toBe(1)
    expect(result.errors.length).toBe(0)

    // Verify
    const b01 = await svc.getNode(buildUid(NodeType.Task, TEST_PROJECT, 'TASK-B01'))
    expect(b01).not.toBeNull()
    expect(b01!.title).toBe('Batch 01')
  })

  it('importBatch is idempotent', async () => {
    const result = await svc.importBatch({
      nodes: [
        { type: NodeType.Task, project: TEST_PROJECT, id: 'TASK-B01', title: 'Batch 01' },
        { type: NodeType.Task, project: TEST_PROJECT, id: 'TASK-B02', title: 'Batch 02' }
      ],
      edges: [
        {
          sourceUid: buildUid(NodeType.Task, TEST_PROJECT, 'TASK-B01'),
          targetUid: buildUid(NodeType.Task, TEST_PROJECT, 'TASK-B02'),
          relation: RelationType.DependsOn
        }
      ]
    })

    expect(result.nodesCreated).toBe(0)
    expect(result.edgesCreated).toBe(0)
  })
})
