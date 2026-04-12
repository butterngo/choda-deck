// Graph layer — public API surface

// Types
export { NodeType, RelationType, buildUid } from './graph-types'
export type { Uid, GraphNode, GraphEdge, ContextResult } from './graph-types'

// Interface
export type {
  GraphService,
  CreateNodeInput,
  UpdateNodeInput,
  FindNodesFilter,
  ImportBatchInput,
  ImportBatchResult
} from './graph-service.interface'

// Config + factory
export { registerGraphProvider, createGraphService } from './graph-config'
export type {
  GraphConfig,
  Neo4jProviderConfig,
  SqliteProviderConfig,
  GraphServiceFactory
} from './graph-config'
