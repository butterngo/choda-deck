/**
 * ADR-030 / 2026-05-28 narrowing — one-shot, best-effort SQLite → Postgres
 * data migration for the *remote-reachable* subset only.
 *
 * The PG adapter implements RemoteOperations (subset of BackendTaskService);
 * tables backing the stdio-only surface (sessions, session_events,
 * agent_memories, context_sources, knowledge_*, tool_invocations, documents)
 * no longer exist on the PG schema and are not migrated. If you need a
 * full round-trip in the future, restore the deleted repos from git history
 * and re-add the tables to MIGRATABLE_TABLES below.
 *
 * Walks the table list in FK-safe order. For each table:
 *   1. Introspect column names on both sides; intersect them. Mismatched
 *      shape → log a warning, skip the column.
 *   2. If Postgres already has rows in the target table → skip (idempotency
 *      guard: re-running the script is a no-op unless --force is passed).
 *   3. Copy in batches of 500 rows via parameterized INSERT.
 *   4. Reset `global_counters.last_number` for entity types the PG side
 *      actually mints (inbox only — task/conv/act/etc. have no PG writers).
 *
 * Usage:
 *   CHODA_PG_URL="postgres://..." node scripts/migrate-sqlite-to-postgres.mjs \
 *     --sqlite path/to/choda-deck.db [--force] [--dry-run]
 *
 * Flags:
 *   --sqlite PATH   Path to source SQLite DB (required).
 *   --force         Wipe destination tables before loading. Off by default.
 *   --dry-run       Introspect + report intended copy plan, do nothing.
 *
 * The script never touches the SQLite file. Re-runnable; safe to ctrl-C
 * (each table is its own transaction).
 */

import { argv, exit, env } from 'node:process'
import Database from 'better-sqlite3'
import pg from 'pg'

/* Tables to migrate, ordered to satisfy FK dependencies. Strict subset of
 * the SQLite schema — anything outside the remote allowlist's call graph
 * has been dropped from the PG side (ADR-026 §Per-tool scoping). */
const MIGRATABLE_TABLES = [
  'projects',
  'workspaces',
  'tasks',
  'tags',
  'relationships',
  'conversations',
  'conversation_participants',
  'conversation_messages',
  'conversation_links',
  'conversation_actions',
  'inbox_items',
  'oauth_clients',
  'oauth_auth_codes',
  'oauth_tokens'
]

/* Counters the PG side actually mints. The narrow facade exposes only
 * createInbox as a write — every other ID space is mint-only on stdio.
 * Migrating non-`inbox` counters serves no PG-side purpose (no writer
 * would ever consume them); kept-out for clarity. */
const COUNTER_RESET_PLAN = [
  { entityType: 'inbox', table: 'inbox_items', idColumn: 'id', prefix: 'INBOX-' }
]

const BATCH_SIZE = 500

function parseArgs(args) {
  const out = { sqlitePath: null, force: false, dryRun: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--sqlite') out.sqlitePath = args[++i]
    else if (a === '--force') out.force = true
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--help' || a === '-h') {
      console.log(USAGE)
      exit(0)
    } else {
      console.error(`unknown arg: ${a}`)
      console.error(USAGE)
      exit(2)
    }
  }
  return out
}

const USAGE = `Usage:
  CHODA_PG_URL="postgres://..." node scripts/migrate-sqlite-to-postgres.mjs \\
    --sqlite path/to/choda-deck.db [--force] [--dry-run]

  --sqlite PATH   path to source SQLite DB (required)
  --force         wipe destination tables before loading (default: skip on non-empty)
  --dry-run       introspect + print plan, write nothing`

function sqliteColumns(db, table) {
  /* PRAGMA table_info returns one row per column; the `name` field is what we
   * intersect against PG. PRAGMA is read-only and doesn't take parameters. */
  return db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name)
}

async function pgColumns(pgClient, table) {
  const r = await pgClient.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [table]
  )
  return r.rows.map((row) => row.column_name)
}

async function pgRowCount(pgClient, table) {
  const r = await pgClient.query(`SELECT COUNT(*)::int AS c FROM ${table}`)
  return r.rows[0]?.c ?? 0
}

async function migrateTable(sqliteDb, pgClient, table, opts) {
  const sqliteCols = sqliteColumns(sqliteDb, table)
  if (sqliteCols.length === 0) {
    console.log(`[skip] ${table}: not present in sqlite`)
    return { copied: 0, skipped: true }
  }
  const pgCols = await pgColumns(pgClient, table)
  if (pgCols.length === 0) {
    console.log(`[skip] ${table}: not present in postgres`)
    return { copied: 0, skipped: true }
  }
  const sharedCols = sqliteCols.filter((c) => pgCols.includes(c))
  const droppedFromSqlite = sqliteCols.filter((c) => !pgCols.includes(c))
  const missingInSqlite = pgCols.filter((c) => !sqliteCols.includes(c))
  if (droppedFromSqlite.length > 0) {
    console.log(
      `[warn] ${table}: sqlite columns not in PG — DATA WILL BE DROPPED: ${droppedFromSqlite.join(', ')}`
    )
  }
  if (missingInSqlite.length > 0) {
    console.log(
      `[info] ${table}: PG columns not in sqlite — will use defaults: ${missingInSqlite.join(', ')}`
    )
  }

  const existingRows = await pgRowCount(pgClient, table)
  if (existingRows > 0 && !opts.force) {
    console.log(`[skip] ${table}: ${existingRows} rows already present (pass --force to wipe + re-load)`)
    return { copied: 0, skipped: true }
  }

  const totalRows = sqliteDb.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c
  if (totalRows === 0) {
    console.log(`[ok]   ${table}: 0 rows in sqlite`)
    return { copied: 0, skipped: false }
  }

  if (opts.dryRun) {
    console.log(
      `[plan] ${table}: would copy ${totalRows} rows across ${sharedCols.length} cols`
    )
    return { copied: totalRows, skipped: false }
  }

  if (opts.force && existingRows > 0) {
    await pgClient.query(`DELETE FROM ${table}`)
  }

  /* Single transaction per table so a mid-copy crash leaves the table either
   * fully migrated or untouched — never half-loaded. */
  await pgClient.query('BEGIN')
  try {
    const selectSql = `SELECT ${sharedCols.join(', ')} FROM ${table}`
    const rows = sqliteDb.prepare(selectSql).all()
    for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
      const batch = rows.slice(offset, offset + BATCH_SIZE)
      const valuePlaceholders = []
      const params = []
      let p = 1
      for (const row of batch) {
        const tuple = sharedCols.map(() => `$${p++}`).join(', ')
        valuePlaceholders.push(`(${tuple})`)
        for (const col of sharedCols) {
          params.push(row[col] ?? null)
        }
      }
      const insertSql = `INSERT INTO ${table} (${sharedCols.join(', ')})
                         VALUES ${valuePlaceholders.join(', ')}
                         ON CONFLICT DO NOTHING`
      await pgClient.query(insertSql, params)
    }
    await pgClient.query('COMMIT')
  } catch (err) {
    await pgClient.query('ROLLBACK')
    throw err
  }

  console.log(`[ok]   ${table}: ${totalRows} rows copied`)
  return { copied: totalRows, skipped: false }
}

async function resetCounters(pgClient, opts) {
  console.log('\n--- global_counters reset ---')
  for (const plan of COUNTER_RESET_PLAN) {
    /* IDs are stored as `${prefix}<digits>` (e.g. INBOX-123). Strip the prefix,
     * take MAX, that's the highest issued counter; next mint = that + 1. */
    const r = await pgClient.query(
      `SELECT COALESCE(MAX(
         CAST(NULLIF(REGEXP_REPLACE(${plan.idColumn}, '^${plan.prefix}', ''), '') AS INTEGER)
       ), 0) AS hi
       FROM ${plan.table}`
    )
    const hi = r.rows[0]?.hi ?? 0
    if (opts.dryRun) {
      console.log(`[plan] counter ${plan.entityType}: would set last_number=${hi}`)
      continue
    }
    await pgClient.query(
      `INSERT INTO global_counters (entity_type, last_number) VALUES ($1, $2)
       ON CONFLICT (entity_type)
       DO UPDATE SET last_number = GREATEST(global_counters.last_number, EXCLUDED.last_number)`,
      [plan.entityType, hi]
    )
    console.log(`[ok]   counter ${plan.entityType}: last_number=${hi}`)
  }
}

async function main() {
  const opts = parseArgs(argv.slice(2))
  if (!opts.sqlitePath) {
    console.error('error: --sqlite is required')
    console.error(USAGE)
    exit(2)
  }
  const connStr = env.CHODA_PG_URL
  if (!connStr) {
    console.error('error: CHODA_PG_URL env var is required')
    console.error(USAGE)
    exit(2)
  }

  console.log(`source: ${opts.sqlitePath}`)
  console.log(`target: ${connStr.replace(/:[^/@]*@/, ':***@')}`)
  console.log(`mode:   ${opts.dryRun ? 'dry-run' : opts.force ? 'force-overwrite' : 'idempotent-skip'}`)
  console.log('')

  const sqliteDb = new Database(opts.sqlitePath, { readonly: true, fileMustExist: true })
  const pgClient = new pg.Client({ connectionString: connStr })
  await pgClient.connect()

  let totalCopied = 0
  try {
    for (const table of MIGRATABLE_TABLES) {
      const r = await migrateTable(sqliteDb, pgClient, table, opts)
      totalCopied += r.copied
    }
    await resetCounters(pgClient, opts)
  } finally {
    await pgClient.end()
    sqliteDb.close()
  }

  console.log('')
  console.log(`done: ${totalCopied} rows ${opts.dryRun ? 'planned' : 'migrated'}`)
}

main().catch((err) => {
  console.error('FATAL:', err)
  exit(1)
})
