// ADR-030 — thin pg.Pool wrapper. Centralizes connect / query / transaction
// so repository code stays free of node-pg specifics and the test harness
// can swap in a testcontainer-backed pool transparently.

import { Pool, type PoolConfig, type QueryResult, type QueryResultRow } from 'pg'

export type SqlValue = string | number | boolean | Date | Buffer | null | undefined

// Shared query surface. Implemented by `PgConnection` (pool-bound, top-level)
// and by the in-tx client `conn.transaction(fn)` hands back. Repositories
// accept `Queryable` so composite lifecycle ops can pass the tx client
// through and share a single transaction across multiple repo calls — see
// ADR-030 slice 15.
//
// `transaction` is optional on the interface: present on the top-level
// `PgConnection`, absent on the in-tx client. Repos that need atomicity for
// an internal multi-statement op use the `runInTx` helper below, which opens
// a fresh tx when called against a pool-bound conn and runs inline when
// already inside an outer tx (so the outer's atomicity covers the inner).
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: readonly SqlValue[]
  ): Promise<QueryResult<R>>
  transaction?<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>
}

// TxClient is the in-tx shape — same as Queryable but no `transaction`.
// Kept as a distinct alias because callbacks read better when typed as
// "inside a tx" rather than as the broader Queryable.
export type TxClient = Queryable

// If `q` can open a transaction (i.e. it's a pool-bound `PgConnection`), do.
// Otherwise we're already in an outer tx — call `fn` with the same client
// so the outer tx's atomicity covers the work. Use this in repository
// methods that need atomicity for a multi-statement op while supporting
// being called from a composite that has already opened a tx.
export async function runInTx<T>(
  q: Queryable,
  fn: (tx: Queryable) => Promise<T>
): Promise<T> {
  if (q.transaction) return q.transaction(fn)
  return fn(q)
}

export class PgConnection implements Queryable {
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
