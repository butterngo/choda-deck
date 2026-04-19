import type Database from 'better-sqlite3'

export class CounterRepository {
  constructor(private readonly db: Database.Database) {}

  nextNumber(entityType: string): number {
    const row = this.db
      .prepare(
        `INSERT INTO global_counters (entity_type, last_number) VALUES (?, 1)
         ON CONFLICT(entity_type) DO UPDATE SET last_number = last_number + 1
         RETURNING last_number`
      )
      .get(entityType) as { last_number: number }
    return row.last_number
  }
}
