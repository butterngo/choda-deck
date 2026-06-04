// ADR-030 / 2026-05-28 narrowing — Postgres migrations, remote-allowlist
// subset only.
//
// Retained tables: global_counters, projects, workspaces, tasks, tags,
// relationships, inbox_items, conversations + 4 sub-tables. (oauth_* were added
// in 010 and dropped in 011 — ADR-034 moved token storage to Keycloak.)
// Dropped (no remote tool reaches them): documents, sessions, session_events,
// context_sources, agent_memories, knowledge_index, knowledge_embeddings,
// tool_invocations. The `vector` extension is no longer installed.
//
// Inlined as TS constants (not .sql files) so the schema travels with the
// bundled MCP server — esbuild ships TS modules cleanly but copying loose
// .sql files into dist/ would need a dedicated build step.
//
// Migration contract: every entry is idempotent at the SQL level
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
    // unchanged. parent_task_id self-FK intentionally absent — TaskRepository.delete
    // NULLs children explicitly on the SQLite side; adding one here would diverge.
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
  },
  {
    // M1 conversation cluster — 5 tables. created_at uses DEFAULT NOW() because
    // the (now-deleted) writer never sets it explicitly. metadata_json on messages
    // is JSONB so node-pg auto-parses round-trip. No CHECK constraints on
    // status/messageType/linkedType — typed at the TS boundary on the stdio side.
    name: '006_conversations',
    sql: `
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        created_by TEXT NOT NULL,
        decision_summary TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        decided_at TEXT,
        closed_at TEXT,
        owner_session_id TEXT,
        owner_type TEXT
      );

      CREATE INDEX IF NOT EXISTS conversations_project_idx ON conversations (project_id);
      CREATE INDEX IF NOT EXISTS conversations_owner_session_idx ON conversations (owner_session_id);

      CREATE TABLE IF NOT EXISTS conversation_participants (
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        participant_name TEXT NOT NULL,
        participant_type TEXT NOT NULL,
        participant_role TEXT,
        PRIMARY KEY (conversation_id, participant_name)
      );

      CREATE INDEX IF NOT EXISTS conv_participants_conv_idx ON conversation_participants (conversation_id);

      CREATE TABLE IF NOT EXISTS conversation_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        author_name TEXT NOT NULL,
        content TEXT NOT NULL,
        message_type TEXT NOT NULL DEFAULT 'comment',
        metadata_json JSONB,
        target_role TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS conv_messages_conv_idx ON conversation_messages (conversation_id);

      CREATE TABLE IF NOT EXISTS conversation_links (
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        linked_type TEXT NOT NULL,
        linked_id TEXT NOT NULL,
        PRIMARY KEY (conversation_id, linked_type, linked_id)
      );

      CREATE INDEX IF NOT EXISTS conv_links_conv_idx ON conversation_links (conversation_id);

      CREATE TABLE IF NOT EXISTS conversation_actions (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        assignee TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        linked_task_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS conv_actions_conv_idx ON conversation_actions (conversation_id);
    `
  },
  {
    // inbox_items only — no CHECK on status (typed via TS unions on the stdio side).
    // project_id nullable + no FK (inbox can hold unscoped scratch items).
    // knowledge_index + knowledge_embeddings dropped — knowledge layer is stdio-only.
    name: '008_inbox',
    sql: `
      CREATE TABLE IF NOT EXISTS inbox_items (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'raw',
        linked_task_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS inbox_project_idx ON inbox_items (project_id);
      CREATE INDEX IF NOT EXISTS inbox_status_idx ON inbox_items (project_id, status);
    `
  },
  {
    // TASK-972 Phase 1 (additive) — signed_off_json column + conversation_message_reads
    // side-table. PG equivalents of SQLite's INSERT OR IGNORE = ON CONFLICT DO NOTHING;
    // SQLite's GROUP_CONCAT = array_agg.
    name: '007_conversation_consensus',
    sql: `
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS signed_off_json TEXT NOT NULL DEFAULT '[]';

      CREATE TABLE IF NOT EXISTS conversation_message_reads (
        message_id TEXT NOT NULL REFERENCES conversation_messages(id),
        participant_name TEXT NOT NULL,
        read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (message_id, participant_name)
      );

      CREATE INDEX IF NOT EXISTS conv_message_reads_message_idx ON conversation_message_reads (message_id);
    `
  },
  {
    // TASK-972 Phase 3 (subtractive) — drop dead/priming fields + narrow status enum.
    // Data migration first: discussing → open, closed/stale → decided. Status CHECK
    // is added last so the rewritten values pass the constraint. Existing review-type
    // messages keep their content verbatim (already composed VERDICT/...); the
    // message_type label column is what gets dropped, not the content.
    name: '008_conversation_subtractive',
    sql: `
      UPDATE conversations SET status = 'open' WHERE status = 'discussing';
      UPDATE conversations SET status = 'decided' WHERE status IN ('closed','stale');

      ALTER TABLE conversations DROP COLUMN IF EXISTS closed_at;
      ALTER TABLE conversation_participants DROP COLUMN IF EXISTS participant_type;
      ALTER TABLE conversation_participants DROP COLUMN IF EXISTS participant_role;
      ALTER TABLE conversation_messages DROP COLUMN IF EXISTS message_type;
      ALTER TABLE conversation_messages DROP COLUMN IF EXISTS metadata_json;
      ALTER TABLE conversation_messages DROP COLUMN IF EXISTS target_role;

      ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_status_check;
      ALTER TABLE conversations ADD CONSTRAINT conversations_status_check
        CHECK (status IN ('open','decided'));
    `
  },
  {
    // ADR-027 OAuth tables. redirect_uris is JSONB so node-pg auto-parses string[].
    // code_challenge_method CHECK preserves 'S256'-only. revoked is BOOLEAN.
    // Token expiry comparisons stay in JS via Date.parse — TEXT timestamps.
    name: '010_oauth',
    sql: `
      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY,
        client_name TEXT NOT NULL,
        redirect_uris JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS oauth_auth_codes (
        code TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
        code_challenge TEXT NOT NULL,
        code_challenge_method TEXT NOT NULL CHECK (code_challenge_method = 'S256'),
        redirect_uri TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS oauth_auth_codes_client_idx ON oauth_auth_codes (client_id);
      CREATE INDEX IF NOT EXISTS oauth_auth_codes_expires_idx ON oauth_auth_codes (expires_at);

      CREATE TABLE IF NOT EXISTS oauth_tokens (
        access_token TEXT PRIMARY KEY,
        refresh_token TEXT UNIQUE NOT NULL,
        client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
        access_expires_at TEXT NOT NULL,
        refresh_expires_at TEXT NOT NULL,
        revoked BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS oauth_tokens_client_idx ON oauth_tokens (client_id);
      CREATE INDEX IF NOT EXISTS oauth_tokens_access_expires_idx ON oauth_tokens (access_expires_at);
    `
  },
  {
    // ADR-034: drop the ADR-027 self-issued OAuth store. Keycloak now issues and
    // stores tokens; choda-deck only validates Keycloak JWTs. 010_oauth stays in
    // history (already applied on existing deploys) — this migration removes it.
    name: '011_drop_oauth',
    sql: `
      DROP TABLE IF EXISTS oauth_auth_codes;
      DROP TABLE IF EXISTS oauth_tokens;
      DROP TABLE IF EXISTS oauth_clients;
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
