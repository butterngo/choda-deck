// ADR-030 / 2026-05-28 narrowing — Postgres relationship repo, read-only.
// Only getForItem is kept (called by task_context). Writes (add/remove) and
// direction-scoped read (getFrom) deleted — no remote tool authors edges,
// and task_context just wants the full edge set per node.

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

  async getForItem(itemId: string): Promise<Relationship[]> {
    const result = await this.conn.query<RelationshipDbRow>(
      'SELECT from_id, to_id, type FROM relationships WHERE from_id = $1 OR to_id = $1',
      [itemId]
    )
    return result.rows.map(mapRow)
  }
}
