import type { Relationship, RelationType } from '../task-types'

export interface RelationshipOperations {
  addRelationship(fromId: string, toId: string, type: RelationType): void
  removeRelationship(fromId: string, toId: string, type: RelationType): void
  getRelationships(itemId: string): Relationship[]
  getRelationshipsFrom(itemId: string, type?: RelationType): Relationship[]
}
