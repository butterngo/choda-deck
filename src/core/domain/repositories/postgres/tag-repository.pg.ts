// ADR-030 — Postgres sibling of TagRepository. Same contract; ON CONFLICT
// DO NOTHING replaces SQLite's INSERT OR IGNORE.

import type { PgConnection } from './connection'

export class PostgresTagRepository {
  constructor(private readonly conn: PgConnection) {}

  async add(itemId: string, tag: string): Promise<void> {
    await this.conn.query(
      'INSERT INTO tags (item_id, tag) VALUES ($1, $2) ON CONFLICT (item_id, tag) DO NOTHING',
      [itemId, tag]
    )
  }

  async remove(itemId: string, tag: string): Promise<void> {
    await this.conn.query('DELETE FROM tags WHERE item_id = $1 AND tag = $2', [itemId, tag])
  }

  async getForItem(itemId: string): Promise<string[]> {
    const result = await this.conn.query<{ tag: string }>(
      'SELECT tag FROM tags WHERE item_id = $1 ORDER BY tag',
      [itemId]
    )
    return result.rows.map((r) => r.tag)
  }

  async findItemsByTag(tag: string): Promise<string[]> {
    const result = await this.conn.query<{ item_id: string }>(
      'SELECT item_id FROM tags WHERE tag = $1 ORDER BY item_id',
      [tag]
    )
    return result.rows.map((r) => r.item_id)
  }
}
