// ADR-030 — Postgres sibling of RelationshipRepository.

import type { Queryable } from './connection'
import type { Relationship, RelationType } from '../../task-types'

interface RelationshipDbRow {
  from_id: string
  to_id: string
  type: string
}

function mapRow(row: RelationshipDbRow): Relationship {
  return { fromId: row.from_id, toId: row.to_id, type: row.type as RelationType }
}

export class PostgresRelationshipRepository {
  constructor(private readonly conn: Queryable) {}

  async add(fromId: string, toId: string, type: RelationType): Promise<void> {
    await this.conn.query(
      `INSERT INTO relationships (from_id, to_id, type) VALUES ($1, $2, $3)
       ON CONFLICT (from_id, to_id, type) DO NOTHING`,
      [fromId, toId, type]
    )
  }

  async remove(fromId: string, toId: string, type: RelationType): Promise<void> {
    await this.conn.query(
      'DELETE FROM relationships WHERE from_id = $1 AND to_id = $2 AND type = $3',
      [fromId, toId, type]
    )
  }

  async getForItem(itemId: string): Promise<Relationship[]> {
    const result = await this.conn.query<RelationshipDbRow>(
      'SELECT from_id, to_id, type FROM relationships WHERE from_id = $1 OR to_id = $1',
      [itemId]
    )
    return result.rows.map(mapRow)
  }

  async getFrom(itemId: string, type?: RelationType): Promise<Relationship[]> {
    const result = type
      ? await this.conn.query<RelationshipDbRow>(
          'SELECT from_id, to_id, type FROM relationships WHERE from_id = $1 AND type = $2',
          [itemId, type]
        )
      : await this.conn.query<RelationshipDbRow>(
          'SELECT from_id, to_id, type FROM relationships WHERE from_id = $1',
          [itemId]
        )
    return result.rows.map(mapRow)
  }
}
