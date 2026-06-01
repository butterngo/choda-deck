import type { Relationship, RelationType } from '../task-types'

export interface RelationshipOperations {
  addRelationship(fromId: string, toId: string, type: RelationType): Promise<void>
  removeRelationship(fromId: string, toId: string, type: RelationType): Promise<void>
  getRelationships(itemId: string): Promise<Relationship[]>
  getRelationshipsFrom(itemId: string, type?: RelationType): Promise<Relationship[]>
  getRelationshipsTo(itemId: string, type?: RelationType): Promise<Relationship[]>
}
