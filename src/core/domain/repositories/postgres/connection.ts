// ADR-030 — thin pg.Pool wrapper. Centralizes connect / query / transaction
// so repository code stays free of node-pg specifics and the test harness
// can swap in a testcontainer-backed pool transparently.

import { Pool, type PoolConfig, type QueryResult, type QueryResultRow } from 'pg'

export type SqlValue = string | number | boolean | Date | Buffer | null | undefined

export interface TxClient {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: readonly SqlValue[]
  ): Promise<QueryResult<R>>
}

export class PgConnection {
  readonly pool: Pool

  constructor(config: PoolConfig | string) {
    this.pool =
      typeof config === 'string' ? new Pool({ connectionString: config }) : new Pool(config)
  }

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: readonly SqlValue[]
  ): Promise<QueryResult<R>> {
    return this.pool.query<R>(text, params as never[])
  }

  async transaction<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await fn(client as TxClient)
      await client.query('COMMIT')
      return result
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // Swallow rollback failure — the original error is what matters.
      }
      throw err
    } finally {
      client.release()
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
