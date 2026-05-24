// ADR-030 — Postgres sibling of CounterRepository.
//
// Same upsert-returning pattern as the SQLite impl, just with $N parameter
// binding and async/await. BIGINT comes back as a string from node-pg by
// default (to avoid precision loss above 2^53) — Number() is safe here
// because realistic counter values stay well under that.

import type { Queryable } from './connection'

export class PostgresCounterRepository {
  constructor(private readonly conn: Queryable) {}

  async nextNumber(entityType: string): Promise<number> {
    const result = await this.conn.query<{ last_number: string }>(
      `INSERT INTO global_counters (entity_type, last_number) VALUES ($1, 1)
       ON CONFLICT (entity_type) DO UPDATE SET last_number = global_counters.last_number + 1
       RETURNING last_number`,
      [entityType]
    )
    return Number(result.rows[0].last_number)
  }
}
