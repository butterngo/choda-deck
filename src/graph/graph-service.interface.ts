import type {
  GraphNode,
  GraphEdge,
  ContextResult,
  Uid,
  NodeType,
  RelationType
} from './graph-types'

export interface CreateNodeInput {
  type: NodeType
  project: string
  id: string
  title: string
  status?: string
  priority?: string
  labels?: string[]
  properties?: Record<string, unknown>
}

export interface UpdateNodeInput {
  title?: string
  status?: string
  priority?: string
  labels?: string[]
  properties?: Record<string, unknown>
}

export interface FindNodesFilter {
  type?: NodeType
  project?: string
  status?: string
  priority?: string
  label?: string
  query?: string
  limit?: number
}

export interface ImportBatchInput {
  nodes: CreateNodeInput[]
  edges: Array<{
    sourceUid: Uid
    targetUid: Uid
    relation: RelationType
    properties?: Record<string, unknown>
  }>
}

export interface ImportBatchResult {
  nodesCreated: number
  edgesCreated: number
  errors: string[]
}

export interface GraphService {
  // Node operations
  createNode(input: CreateNodeInput): Promise<GraphNode>
  updateNode(uid: Uid, input: UpdateNodeInput): Promise<GraphNode>
  deleteNode(uid: Uid): Promise<void>
  getNode(uid: Uid): Promise<GraphNode | null>
  findNodes(filter: FindNodesFilter): Promise<GraphNode[]>

  // Relationship operations
  createRelationship(
    sourceUid: Uid,
    targetUid: Uid,
    relation: RelationType,
    properties?: Record<string, unknown>
  ): Promise<GraphEdge>
  deleteRelationship(sourceUid: Uid, targetUid: Uid, relation: RelationType): Promise<void>
  getRelationships(uid: Uid, direction?: 'in' | 'out' | 'both'): Promise<GraphEdge[]>

  // Context query
  getContext(uid: Uid, depth?: number): Promise<ContextResult>

  // Bulk operations
  importBatch(input: ImportBatchInput): Promise<ImportBatchResult>

  // Lifecycle
  connect(): Promise<void>
  disconnect(): Promise<void>
}
