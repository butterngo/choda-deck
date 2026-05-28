// ADR-030 / 2026-05-28 narrowing — Postgres tag repo, read-only.
// Only getForItem is kept (called by task_context). Writes (add/remove) and
// reverse lookup (findItemsByTag) deleted — no remote tool can author tags.

import type { Queryable } from './connection'

export class PostgresTagRepository {
  constructor(private readonly conn: Queryable) {}

  async getForItem(itemId: string): Promise<string[]> {
    const result = await this.conn.query<{ tag: string }>(
      'SELECT tag FROM tags WHERE item_id = $1 ORDER BY tag',
      [itemId]
    )
    return result.rows.map((r) => r.tag)
  }
}
