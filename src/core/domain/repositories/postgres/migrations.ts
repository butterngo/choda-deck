// ADR-030 — Postgres migrations. Inlined as TS constants (not .sql files)
// so the schema travels with the bundled MCP server — esbuild ships TS
// modules cleanly but copying loose .sql files into dist/ would need a
// dedicated build step.
//
// Migration contract: every entry must be idempotent at the SQL level
// (CREATE IF NOT EXISTS, etc.) — the runner ALSO gates on the `_migrations`
// table, but defense in depth is cheap.

import type { PgConnection } from './connection'

export interface Migration {
  name: string
  sql: string
}

export const MIGRATIONS: readonly Migration[] = [
  {
    name: '001_init',
    sql: `
      CREATE TABLE IF NOT EXISTS global_counters (
        entity_type TEXT PRIMARY KEY,
        last_number BIGINT NOT NULL DEFAULT 0
      );
    `
  }
]

export interface MigrateResult {
  applied: string[]
  skipped: string[]
}

export async function migrate(conn: PgConnection): Promise<MigrateResult> {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  const existing = await conn.query<{ name: string }>('SELECT name FROM _migrations')
  const appliedSet = new Set(existing.rows.map((r) => r.name))

  const applied: string[] = []
  const skipped: string[] = []

  for (const m of MIGRATIONS) {
    if (appliedSet.has(m.name)) {
      skipped.push(m.name)
      continue
    }
    await conn.transaction(async (tx) => {
      await tx.query(m.sql)
      await tx.query('INSERT INTO _migrations (name) VALUES ($1)', [m.name])
    })
    applied.push(m.name)
  }

  return { applied, skipped }
}
