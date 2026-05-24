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
  },
  {
    // Timestamps stay TEXT so caller-supplied strings round-trip verbatim
    // (sessions test their startedAt/endedAt by exact string in places).
    // handoff/checkpoint are JSONB so node-pg auto-parses on read — saves
    // the SQLite-side JSON.parse dance.
    name: '004_sessions',
    sql: `
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        workspace_id TEXT,
        task_id TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed')),
        handoff_json JSONB,
        checkpoint JSONB,
        checkpoint_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS sessions_project_idx ON sessions (project_id);
      CREATE INDEX IF NOT EXISTS sessions_status_idx ON sessions (project_id, status);
      CREATE INDEX IF NOT EXISTS sessions_workspace_idx ON sessions (workspace_id);
      CREATE INDEX IF NOT EXISTS sessions_task_active_idx ON sessions (task_id, status);
    `
  },
  {
    // `is_active` is BOOLEAN (SQLite stored INTEGER 0/1); priority is a small int.
    // No CHECK on source_type/category — kept open to mirror the SQLite side,
    // which validates at the TypeScript boundary via the typed unions.
    name: '005_context_sources',
    sql: `
      CREATE TABLE IF NOT EXISTS context_sources (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        source_type TEXT NOT NULL,
        source_path TEXT NOT NULL,
        label TEXT NOT NULL,
        category TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 100,
        is_active BOOLEAN NOT NULL DEFAULT TRUE
      );

      CREATE INDEX IF NOT EXISTS context_sources_project_idx ON context_sources (project_id);
    `
  },
  {
    // M1 conversation cluster — 5 tables. created_at uses DEFAULT NOW() because
    // the repo never sets it explicitly (matches SQLite `DEFAULT datetime('now')`).
    // metadata_json on messages is JSONB so node-pg auto-parses round-trip.
    // No CHECK constraints on status/messageType/linkedType/etc — typed at the TS
    // boundary, same as SQLite.
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
    // M2 cluster (ADR-023 agent memory): session_events + agent_memories.
    // payload_json stays TEXT because the contract is `string | null` — callers
    // pre-stringify, and may pass non-JSON blobs. tags + source_event_ids are
    // JSONB so node-pg auto-parses string[] back without the SQLite-side helper.
    // CHECK constraints inline match the SQLite definitions verbatim.
    name: '007_m2',
    sql: `
      CREATE TABLE IF NOT EXISTS session_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        event_type TEXT NOT NULL,
        payload_json TEXT,
        memory_candidate BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS session_events_session_idx ON session_events (session_id, created_at);

      CREATE TABLE IF NOT EXISTS agent_memories (
        id TEXT PRIMARY KEY,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('user','project','workspace','task')),
        scope_id TEXT NOT NULL,
        memory_type TEXT NOT NULL CHECK (memory_type IN ('episodic','procedural')),
        content TEXT NOT NULL,
        tags JSONB,
        importance INTEGER NOT NULL DEFAULT 50,
        source_session_id TEXT,
        source_event_ids JSONB,
        created_at TEXT NOT NULL,
        last_recalled_at TEXT,
        recall_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS agent_memories_scope_idx ON agent_memories (scope_type, scope_id, memory_type);
      CREATE INDEX IF NOT EXISTS agent_memories_recall_idx ON agent_memories (importance DESC, recall_count DESC);
    `
  },
  {
    // inbox: no CHECK on status (matches SQLite — typed via TS unions).
    // project_id nullable + no FK (inbox can hold unscoped scratch items).
    //
    // knowledge_index: CHECK on scope + type inline (SQLite has them too).
    // FK to projects required; workspace_id (ADR-022) optional FK.
    // embedding_provider_id + embedding_dims columns are forward-compat for the
    // pgvector embedding store slice — the current repo doesn't expose them.
    name: '008_inbox_knowledge',
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

      CREATE TABLE IF NOT EXISTS knowledge_index (
        slug TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        workspace_id TEXT REFERENCES workspaces(id),
        scope TEXT NOT NULL CHECK (scope IN ('project','cross')),
        type TEXT NOT NULL CHECK (type IN ('spike','decision','postmortem','learning','evaluation')),
        title TEXT NOT NULL,
        file_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_verified_at TEXT NOT NULL,
        embedding_provider_id TEXT,
        embedding_dims INTEGER
      );

      CREATE INDEX IF NOT EXISTS knowledge_project_idx ON knowledge_index (project_id);
      CREATE INDEX IF NOT EXISTS knowledge_type_idx ON knowledge_index (project_id, type);
      CREATE INDEX IF NOT EXISTS knowledge_scope_idx ON knowledge_index (project_id, scope);
      CREATE INDEX IF NOT EXISTS knowledge_workspace_idx ON knowledge_index (workspace_id);
    `
  },
  {
    // tool_invocations (TASK-681). SQLite used INTEGER PRIMARY KEY autoincrement;
    // Postgres uses BIGINT GENERATED BY DEFAULT AS IDENTITY (the modern, ORM-free
    // replacement for SERIAL/BIGSERIAL). ok is native BOOLEAN (vs SQLite 0/1) —
    // aggregate query uses COUNT(*) FILTER (WHERE NOT ok) instead of SUM(1-ok).
    // ts stays TEXT for caller-supplied ISO strings.
    name: '009_tool_invocations',
    sql: `
      CREATE TABLE IF NOT EXISTS tool_invocations (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        tool_name TEXT NOT NULL,
        ts TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        ok BOOLEAN NOT NULL,
        error_kind TEXT
      );

      CREATE INDEX IF NOT EXISTS tool_invocations_tool_ts_idx ON tool_invocations (tool_name, ts);
    `
  },
  {
    // ADR-027 OAuth tables. redirect_uris is JSONB (vs SQLite TEXT/JSON-string)
    // so node-pg auto-parses string[]. code_challenge_method CHECK preserves
    // 'S256'-only from the SQLite side. revoked is BOOLEAN (vs INTEGER 0/1).
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
    // pgvector sibling of the sqlite-vec `knowledge_vec` virtual table.
    // CREATE EXTENSION needs the role to own the database (testcontainers
    // default) or be superuser. Fails fast at startup with a clear error
    // ("extension \"vector\" is not available") if pgvector isn't installed
    // on the server — matches the task's "fail fast" requirement.
    //
    // Schema choice: unconstrained `vector` (no fixed dim at table-create
    // time) + per-row `dims` column. Diverges from SQLite which must DROP
    // and recreate on dim change because sqlite-vec virtual tables bake the
    // dim into the table. Here we clear rows + reset knowledge_index
    // embedding columns on provider mismatch in PgVectorEmbeddingStore.
    //
    // No HNSW/IVFFlat index — the knowledge layer is small-scale (dozens
    // to hundreds of rows) and brute-force <-> scan is well under 1ms.
    // Add an index when a project crosses ~10k rows.
    name: '011_embeddings',
    sql: `
      CREATE EXTENSION IF NOT EXISTS vector;

      CREATE TABLE IF NOT EXISTS knowledge_embeddings (
        slug TEXT PRIMARY KEY REFERENCES knowledge_index(slug) ON DELETE CASCADE,
        provider_id TEXT NOT NULL,
        dims INTEGER NOT NULL,
        embedding vector NOT NULL
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
