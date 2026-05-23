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
  },
  {
    name: '002_core',
    sql: `
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cwd TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        label TEXT NOT NULL,
        cwd TEXT NOT NULL,
        archived_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS workspaces_project_id_idx ON workspaces (project_id);
    `
  },
  {
    // labels → jsonb (string[]); pinned → boolean; created/updated → timestamptz.
    // due_date stays TEXT so caller-supplied strings (e.g. "2026-05-23") round-trip
    // unchanged — TIMESTAMPTZ would canonicalize them to a different shape than
    // the SQLite side. parent_task_id self-FK is intentionally absent —
    // TaskRepository.delete NULLs children explicitly, and the SQLite side
    // never declared the FK either; adding one here would diverge behaviour.
    name: '003_tasks',
    sql: `
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        parent_task_id TEXT,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'TODO',
        priority TEXT,
        labels JSONB,
        due_date TEXT,
        pinned BOOLEAN NOT NULL DEFAULT FALSE,
        file_path TEXT,
        body TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks (project_id);
      CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks (project_id, status);
      CREATE INDEX IF NOT EXISTS tasks_parent_idx ON tasks (parent_task_id);

      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        file_path TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS documents_project_idx ON documents (project_id);

      CREATE TABLE IF NOT EXISTS tags (
        item_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        PRIMARY KEY (item_id, tag)
      );

      CREATE INDEX IF NOT EXISTS tags_item_idx ON tags (item_id);

      CREATE TABLE IF NOT EXISTS relationships (
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        type TEXT NOT NULL,
        PRIMARY KEY (from_id, to_id, type)
      );

      CREATE INDEX IF NOT EXISTS relationships_from_idx ON relationships (from_id);
      CREATE INDEX IF NOT EXISTS relationships_to_idx ON relationships (to_id);
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
