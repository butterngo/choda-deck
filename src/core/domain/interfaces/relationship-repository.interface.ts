import type { Relationship, RelationType } from '../task-types'

export interface RelationshipOperations {
  addRelationship(fromId: string, toId: string, type: RelationType): Promise<void>
  removeRelationship(fromId: string, toId: string, type: RelationType): Promise<void>
  getRelationships(itemId: string): Promise<Relationship[]>
  getRelationshipsFrom(itemId: string, type?: RelationType): Promise<Relationship[]>
  getRelationshipsTo(itemId: string, type?: RelationType): Promise<Relationship[]>
  // Full-graph read (TASK-1443) — edges where BOTH endpoints are in `ids`.
  // Callers assemble `ids` from a project's own nodes so cross-project edges
  // never leak into the result.
  getRelationshipsForNodes(ids: string[]): Promise<Relationship[]>
}
