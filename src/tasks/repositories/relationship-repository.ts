import type Database from 'better-sqlite3'
import type { Relationship, RelationType } from '../task-types'

function rowToRelationship(row: { from_id: string; to_id: string; type: string }): Relationship {
  return { fromId: row.from_id, toId: row.to_id, type: row.type as RelationType }
}

export class RelationshipRepository {
  constructor(private readonly db: Database.Database) {}

  add(fromId: string, toId: string, type: RelationType): void {
    this.db.prepare('INSERT OR IGNORE INTO relationships (from_id, to_id, type) VALUES (?, ?, ?)').run(fromId, toId, type)
  }

  remove(fromId: string, toId: string, type: RelationType): void {
    this.db.prepare('DELETE FROM relationships WHERE from_id = ? AND to_id = ? AND type = ?').run(fromId, toId, type)
  }

  getForItem(itemId: string): Relationship[] {
    const rows = this.db.prepare(
      'SELECT * FROM relationships WHERE from_id = ? OR to_id = ?'
    ).all(itemId, itemId) as Array<{ from_id: string; to_id: string; type: string }>
    return rows.map(rowToRelationship)
  }

  getFrom(itemId: string, type?: RelationType): Relationship[] {
    const rows = type
      ? this.db.prepare('SELECT * FROM relationships WHERE from_id = ? AND type = ?').all(itemId, type) as Array<{ from_id: string; to_id: string; type: string }>
      : this.db.prepare('SELECT * FROM relationships WHERE from_id = ?').all(itemId) as Array<{ from_id: string; to_id: string; type: string }>
    return rows.map(rowToRelationship)
  }
}
