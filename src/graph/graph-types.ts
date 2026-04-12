// Graph data types — pure types, zero runtime dependencies

export enum NodeType {
  Task = 'task',
  Feature = 'feature',
  Decision = 'decision',
  Project = 'project'
}

export enum RelationType {
  DependsOn = 'depends-on',
  Blocks = 'blocks',
  PartOf = 'part-of',
  RelatesTo = 'relates-to',
  Implements = 'implements'
}

/**
 * UID format: "{type}:{project}/{id}"
 * Example: "task:task-management/TASK-130"
 */
export type Uid = string

export interface GraphNode {
  uid: Uid
  type: NodeType
  project: string
  id: string
  title: string
  status?: string
  priority?: string
  labels?: string[]
  properties?: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface GraphEdge {
  source: Uid
  target: Uid
  relation: RelationType
  properties?: Record<string, unknown>
}

export interface ContextResult {
  root: GraphNode
  related: GraphNode[]
  edges: GraphEdge[]
}

export function buildUid(type: NodeType, project: string, id: string): Uid {
  return `${type}:${project}/${id}`
}
