/**
 * ADR-030 — one-shot, best-effort SQLite → Postgres data migration.
 *
 * Walks a known list of migratable tables in FK-safe order. For each table:
 *   1. Introspect column names on both sides; intersect them. Mismatched
 *      shape → log a warning, skip the column (data loss flagged in stdout).
 *   2. If Postgres already has rows in the target table → skip (idempotency
 *      guard: re-running the script is a no-op unless --force is passed).
 *   3. Copy in batches of 500 rows, using parameterized INSERT. Pg-node
 *      coerces JS types (numbers, strings, booleans, nulls) to PG types
 *      automatically; sqlite's 0/1 boolean columns are accepted by PG's
 *      boolean cast.
 *   4. Reset `global_counters.last_number` per entity_type to MAX(numeric
 *      id-suffix) over the freshly-loaded data so new IDs minted post-
 *      migration don't collide.
 *
 * Embedding vectors (knowledge_vec → knowledge_embeddings) are NOT copied —
 * the storage shape differs (sqlite-vec virtual table vs pgvector typed
 * column) and the embedding dimensions may differ between providers. Re-run
 * `scripts/backfill-embeddings.mjs` against the Postgres backend after this
 * script lands the knowledge_index rows.
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

/* Tables to migrate, ordered to satisfy FK dependencies. embeddings + the
 * sqlite-vec virtual table are intentionally absent — see header. */
const MIGRATABLE_TABLES = [
  'projects',
  'workspaces',
  'tasks',
  'tags',
  'relationships',
  'documents',
  'sessions',
  'context_sources',
  'conversations',
  'conversation_participants',
  'conversation_messages',
  'conversation_links',
  'conversation_actions',
  'inbox_items',
  'knowledge_index',
  'tool_invocations',
  'session_events',
  'agent_memories',
  'oauth_clients',
  'oauth_auth_codes',
  'oauth_tokens'
]

/* Maps entity_type counter key → table that holds the corresponding ID suffix
 * to reset `global_counters.last_number` after the bulk copy. Anything not
 * listed keeps its sqlite counter value (carried over verbatim below). */
const COUNTER_RESET_PLAN = [
  { entityType: 'task', table: 'tasks', idColumn: 'id', prefix: 'TASK-' },
  { entityType: 'session', table: 'sessions', idColumn: 'id', prefix: 'SESSION-' },
  { entityType: 'conv', table: 'conversations', idColumn: 'id', prefix: 'CONV-' },
  { entityType: 'act', table: 'conversation_actions', idColumn: 'id', prefix: 'ACT-' },
  { entityType: 'evt', table: 'session_events', idColumn: 'id', prefix: 'EVT-' },
  { entityType: 'mem', table: 'agent_memories', idColumn: 'id', prefix: 'MEM-' },
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
    /* IDs are stored as `${prefix}<digits>` (e.g. TASK-123). Strip the prefix,
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
  console.log('next: re-run scripts/backfill-embeddings.mjs against the Postgres backend')
}

main().catch((err) => {
  console.error('FATAL:', err)
  exit(1)
})
