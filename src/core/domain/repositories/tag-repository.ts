import type Database from 'better-sqlite3'

export class TagRepository {
  constructor(private readonly db: Database.Database) {}

  add(itemId: string, tag: string): void {
    this.db.prepare('INSERT OR IGNORE INTO tags (item_id, tag) VALUES (?, ?)').run(itemId, tag)
  }

  remove(itemId: string, tag: string): void {
    this.db.prepare('DELETE FROM tags WHERE item_id = ? AND tag = ?').run(itemId, tag)
  }

  getForItem(itemId: string): string[] {
    const rows = this.db
      .prepare('SELECT tag FROM tags WHERE item_id = ? ORDER BY tag')
      .all(itemId) as Array<{ tag: string }>
    return rows.map((row) => row.tag)
  }

  findItemsByTag(tag: string): string[] {
    const rows = this.db
      .prepare('SELECT item_id FROM tags WHERE tag = ? ORDER BY item_id')
      .all(tag) as Array<{ item_id: string }>
    return rows.map((row) => row.item_id)
  }
}
