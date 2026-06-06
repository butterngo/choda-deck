import type Database from 'better-sqlite3'
import { createSyncClockTables } from '../../sync/lamport-clock'
import { SYNCABLE_TABLES, SYNC_COLUMNS } from '../../sync/syncable-tables'

const SCHEMA_VERSION = 5

export function initSchema(db: Database.Database): void {
  createCoreTables(db)
  runLegacyMigrations(db)
  createM1Tables(db)
  createM2Tables(db)
  dropLegacyOAuthTables(db)
  addSyncColumns(db)
  createSyncClockTables(db)
  createIndexes(db)
  cleanupPoisonedTaskIds(db)
  seedSchemaVersion(db)
}

// ADR-030 Phase 1 (TASK-978) — additive sync metadata on every syncable table.
// updated_at/deleted_at/origin are added with NULL defaults; nothing writes them
// yet (zero behavior change). SQLite has no `ADD COLUMN IF NOT EXISTS`, so each
// ALTER is wrapped in try/catch — the established idempotency pattern in this file.
// The table + column lists live in src/core/sync/syncable-tables.ts, shared with
// the Postgres migration so the two backends cannot drift.
function addSyncColumns(db: Database.Database): void {
  for (const table of SYNCABLE_TABLES) {
    for (const col of SYNC_COLUMNS) {
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${col.name} ${col.sqliteType}`)
      } catch {
        /* column exists */
      }
    }
  }
}

function seedSchemaVersion(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL
    )
  `)
  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
    | { version: number }
    | undefined
  if (!row) {
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION)
  } else if (row.version < SCHEMA_VERSION) {
    db.prepare('UPDATE schema_version SET version = ?').run(SCHEMA_VERSION)
  }
}

function createCoreTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cwd TEXT NOT NULL
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      label TEXT NOT NULL,
      cwd TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_task_id TEXT,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'TODO',
      priority TEXT,
      labels TEXT,
      due_date TEXT,
      pinned INTEGER DEFAULT 0,
      file_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS tags (
      item_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (item_id, tag)
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS relationships (
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      type TEXT NOT NULL,
      PRIMARY KEY (from_id, to_id, type)
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      file_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
}

function runLegacyMigrations(db: Database.Database): void {
  db.exec('DROP TABLE IF EXISTS epics')
  db.exec('DROP TABLE IF EXISTS task_dependencies')
  try {
    db.exec('DROP INDEX IF EXISTS idx_tasks_epic')
  } catch {
    /* ok */
  }

  // Feature entity removed (TASK-516) — Phase → Task hierarchy is direct
  db.exec('DROP INDEX IF EXISTS idx_tasks_feature')
  db.exec('DROP INDEX IF EXISTS idx_features_project')
  db.exec('DROP INDEX IF EXISTS idx_features_phase')
  db.exec('DROP TABLE IF EXISTS features')
  try {
    db.exec('ALTER TABLE tasks DROP COLUMN feature_id')
  } catch {
    /* already dropped */
  }

  // M1 conversation schema migration
  try {
    db.exec("ALTER TABLE conversations ADD COLUMN created_by TEXT NOT NULL DEFAULT ''")
  } catch {
    /* exists */
  }
  try {
    db.exec('ALTER TABLE conversations ADD COLUMN decided_at TEXT')
  } catch {
    /* exists */
  }

  // session: add workspace_id, task_id
  try {
    db.exec('ALTER TABLE sessions ADD COLUMN workspace_id TEXT')
  } catch {
    /* exists */
  }
  try {
    db.exec('ALTER TABLE sessions ADD COLUMN task_id TEXT')
  } catch {
    /* exists */
  }

  // TASK-626: phase concept dropped — remove phase_id column + phases table
  db.exec('DROP INDEX IF EXISTS idx_tasks_phase')
  db.exec('DROP INDEX IF EXISTS idx_phases_project')
  try {
    db.exec('ALTER TABLE tasks DROP COLUMN phase_id')
  } catch {
    /* already dropped */
  }
  db.exec('DROP TABLE IF EXISTS phases')

  // tasks: body content (SQLite becomes source of truth for content)
  try {
    db.exec('ALTER TABLE tasks ADD COLUMN body TEXT')
  } catch {
    /* exists */
  }

  // Conversation attribution — ownerType marks human-driven interactive convs.
  try {
    db.exec('ALTER TABLE conversations ADD COLUMN owner_session_id TEXT')
  } catch {
    /* exists */
  }
  try {
    db.exec('ALTER TABLE conversations ADD COLUMN owner_type TEXT')
  } catch {
    /* exists */
  }

  // TASK-550: session checkpoint (crash-recovery snapshot while session stays active)
  try {
    db.exec('ALTER TABLE sessions ADD COLUMN checkpoint TEXT')
  } catch {
    /* exists */
  }
  try {
    db.exec('ALTER TABLE sessions ADD COLUMN checkpoint_at TEXT')
  } catch {
    /* exists */
  }

  // TASK-985 (ADR-031): Claude Code transcript session UUID for resumePoint derivation
  try {
    db.exec('ALTER TABLE sessions ADD COLUMN cc_session_id TEXT')
  } catch {
    /* exists */
  }

  // TASK-552: soft-delete for workspaces
  try {
    db.exec('ALTER TABLE workspaces ADD COLUMN archived_at TEXT')
  } catch {
    /* exists */
  }
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_workspaces_active ON workspaces(project_id, archived_at)'
  )


  // Global counter table — replaces per-project counters.
  // IDs (TASK-NNN, INBOX-NNN) must be globally unique because PKs are single column.
  // Per-project resetting would collide across projects.
  db.exec(`
    CREATE TABLE IF NOT EXISTS global_counters (
      entity_type TEXT PRIMARY KEY,
      last_number INTEGER NOT NULL DEFAULT 0
    )
  `)
  seedGlobalCounter(db, 'task', "SELECT id FROM tasks WHERE id GLOB 'TASK-[0-9]*'", 5)
  seedGlobalCounter(db, 'inbox', "SELECT id FROM inbox_items WHERE id GLOB 'INBOX-[0-9]*'", 6)
  db.exec('DROP TABLE IF EXISTS project_task_counters')
  db.exec('DROP TABLE IF EXISTS project_inbox_counters')

  // conversation_messages: rename author → author_name, add metadata_json
  migrateConversationMessages(db)

  // TASK-526: collapse session status 3→2 + add CHECK constraint
  migrateSessionsStatus(db)

  // TASK-972 Phase 1+3 (combined in this PR): conversation schema narrowing.
  // Adds signed_off_json + conversation_message_reads; drops type/role/messageType/
  // metadata/targetRole/closedAt; narrows status enum to (open|decided).
  // Runs at the end so older legacy migrations have completed first.
  migrateConversationSchemaNarrowing(db)
}

function migrateSessionsStatus(db: Database.Database): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'")
    .get() as { sql?: string } | undefined
  if (!row?.sql) return // no sessions table yet — createM1Tables will make one with CHECK
  if (row.sql.includes('CHECK') && row.sql.includes('status IN')) return // already migrated

  db.exec("UPDATE sessions SET status = 'completed' WHERE status = 'abandoned'")
  db.exec(`
    CREATE TABLE sessions_new (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      workspace_id TEXT,
      task_id TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed')),
      handoff_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id)
    )
  `)
  db.exec(`
    INSERT INTO sessions_new (id, project_id, workspace_id, task_id, started_at, ended_at, status, handoff_json, created_at)
    SELECT id, project_id, workspace_id, task_id, started_at, ended_at, status, handoff_json, created_at FROM sessions
  `)
  db.exec('DROP TABLE sessions')
  db.exec('ALTER TABLE sessions_new RENAME TO sessions')
}

// TASK-988: rebuild knowledge_index when its live CHECK predates the
// feature/code_ref/gotcha types. Idempotent — skipped once the widened CHECK is
// present. Copies every column the live table has (embedding_* and workspace_id
// arrived via ALTER, so the column set varies by DB age) into a fresh table.
function migrateKnowledgeTypeCheck(db: Database.Database): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='knowledge_index'")
    .get() as { sql?: string } | undefined
  if (!row?.sql) return // table not created yet
  if (row.sql.includes("'feature'")) return // already widened

  const cols = (db.pragma('table_info(knowledge_index)') as Array<{ name: string }>).map(
    (c) => c.name
  )
  const colList = cols.join(', ')

  db.exec(`
    CREATE TABLE knowledge_index_new (
      slug TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('project','cross')),
      type TEXT NOT NULL CHECK (type IN ('spike','decision','postmortem','learning','evaluation','feature','code_ref','gotcha')),
      title TEXT NOT NULL,
      file_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_verified_at TEXT NOT NULL,
      embedding_provider_id TEXT,
      embedding_dims INTEGER,
      workspace_id TEXT REFERENCES workspaces(id),
      FOREIGN KEY (project_id) REFERENCES projects(id)
    )
  `)
  db.exec(`INSERT INTO knowledge_index_new (${colList}) SELECT ${colList} FROM knowledge_index`)
  db.exec('DROP TABLE knowledge_index')
  db.exec('ALTER TABLE knowledge_index_new RENAME TO knowledge_index')
}

// Any parsed ID above this is assumed to be a legacy timestamp-style ID
// (Date.now() ~ 1.7e12) rather than a real counter value. Seeding from such
// IDs poisons the counter permanently — every new ID becomes timestamp+1.
const COUNTER_SANE_MAX = 100_000

function seedGlobalCounter(
  db: Database.Database,
  entityType: string,
  selectIdSql: string,
  prefixLen: number
): void {
  let max = 0
  try {
    const rows = db.prepare(selectIdSql).all() as Array<{ id: string }>
    for (const r of rows) {
      const n = parseInt(r.id.slice(prefixLen), 10)
      if (!isNaN(n) && n > max && n <= COUNTER_SANE_MAX) max = n
    }
  } catch {
    /* table may not exist yet on first bootstrap */
  }
  const existing = db
    .prepare('SELECT last_number FROM global_counters WHERE entity_type = ?')
    .get(entityType) as { last_number: number } | undefined
  if (existing && existing.last_number > COUNTER_SANE_MAX) {
    // Counter was poisoned by a legacy timestamp-style ID — force reset down.
    db.prepare('UPDATE global_counters SET last_number = ? WHERE entity_type = ?').run(
      max,
      entityType
    )
    return
  }
  db.prepare(
    `INSERT INTO global_counters (entity_type, last_number) VALUES (?, ?)
     ON CONFLICT(entity_type) DO UPDATE SET last_number = MAX(last_number, excluded.last_number)`
  ).run(entityType, max)
}

// TASK-972 Phase 1+3 — shipped together because we go straight to target schema
// in one branch. Steps:
//   0. Drop any leftover `*_new` tables from a previously-aborted migration.
//   1. Backfill conversations.signed_off_json (additive — new column, default '[]').
//   2. Create conversation_message_reads side-table + index (additive — new table).
//   3. Migrate conversation status values: discussing→open, closed/stale→decided.
//   4. Recreate conversations table dropping closed_at + narrowing status CHECK.
//      Recreate is required (not ALTER ... DROP COLUMN) because we need to change
//      the CHECK constraint. Foreign keys are temporarily disabled because four
//      child tables FK into conversations(id) — DROP TABLE conversations would
//      otherwise fail. Idempotent: skipped when the live schema already matches
//      the target shape.
//   5. participants + messages use simple ALTER TABLE ... DROP COLUMN (SQLite
//      3.35+) — cheaper than recreate and safe since neither carries the CHECK.
//
// PRAGMA foreign_keys cannot be flipped inside an active transaction in SQLite,
// so the foreign-key toggle wraps the transaction, not the other way around.
function migrateConversationSchemaNarrowing(db: Database.Database): void {
  const convCols = db.pragma('table_info(conversations)') as Array<{ name: string }>
  if (convCols.length === 0) return // conversations table not created yet (fresh DB on first boot — createM1Tables runs after)

  // Step 0: clean up any half-migrated leftovers.
  db.exec('DROP TABLE IF EXISTS conversations_new')
  db.exec('DROP TABLE IF EXISTS conversation_participants_new')
  db.exec('DROP TABLE IF EXISTS conversation_messages_new')

  const convColNames = new Set(convCols.map((c) => c.name))

  // Step 1: signed_off_json (additive).
  if (!convColNames.has('signed_off_json')) {
    try {
      db.exec(
        "ALTER TABLE conversations ADD COLUMN signed_off_json TEXT NOT NULL DEFAULT '[]'"
      )
    } catch {
      /* exists */
    }
  }

  // Step 2: conversation_message_reads side-table (additive).
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_message_reads (
      message_id TEXT NOT NULL,
      participant_name TEXT NOT NULL,
      read_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (message_id, participant_name),
      FOREIGN KEY (message_id) REFERENCES conversation_messages(id)
    )
  `)
  db.exec(
    'CREATE INDEX IF NOT EXISTS conv_message_reads_message_idx ON conversation_message_reads (message_id)'
  )

  // Step 3: status value migration.
  db.exec("UPDATE conversations SET status = 'open' WHERE status = 'discussing'")
  db.exec("UPDATE conversations SET status = 'decided' WHERE status IN ('closed','stale')")

  // Step 4: conversations table — drop closed_at + narrow CHECK via recreate.
  const conversationsSql =
    (db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='conversations'")
      .get() as { sql?: string } | undefined)?.sql ?? ''
  const needsConvRecreate =
    convColNames.has('closed_at') ||
    !/CHECK\s*\(\s*status\s+IN\s*\(\s*'open'\s*,\s*'decided'\s*\)\s*\)/i.test(conversationsSql)

  if (needsConvRecreate) {
    // PRAGMA foreign_keys must change outside any transaction; the recreate runs
    // inside a transaction so a mid-step crash rolls back atomically.
    db.pragma('foreign_keys = OFF')
    try {
      const recreate = db.transaction(() => {
        db.exec(`
          CREATE TABLE conversations_new (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            title TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','decided')),
            created_by TEXT NOT NULL,
            decision_summary TEXT,
            signed_off_json TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            decided_at TEXT,
            owner_session_id TEXT,
            owner_type TEXT,
            FOREIGN KEY (project_id) REFERENCES projects(id)
          )
        `)
        db.exec(`
          INSERT INTO conversations_new (id, project_id, title, status, created_by, decision_summary, signed_off_json, created_at, decided_at, owner_session_id, owner_type)
          SELECT id, project_id, title, status, created_by, decision_summary, signed_off_json, created_at, decided_at, owner_session_id, owner_type FROM conversations
        `)
        db.exec('DROP TABLE conversations')
        db.exec('ALTER TABLE conversations_new RENAME TO conversations')
      })
      recreate()
    } finally {
      db.pragma('foreign_keys = ON')
    }
  }

  // Step 5a: conversation_participants — drop type + role via simple ALTER.
  const partCols = db.pragma('table_info(conversation_participants)') as Array<{ name: string }>
  const partColNames = new Set(partCols.map((c) => c.name))
  if (partColNames.has('participant_type')) {
    db.exec('ALTER TABLE conversation_participants DROP COLUMN participant_type')
  }
  if (partColNames.has('participant_role')) {
    db.exec('ALTER TABLE conversation_participants DROP COLUMN participant_role')
  }

  // Step 5b: conversation_messages — drop message_type, metadata_json, target_role.
  const msgCols = db.pragma('table_info(conversation_messages)') as Array<{ name: string }>
  const msgColNames = new Set(msgCols.map((c) => c.name))
  if (msgColNames.has('message_type')) {
    db.exec('ALTER TABLE conversation_messages DROP COLUMN message_type')
  }
  if (msgColNames.has('metadata_json')) {
    db.exec('ALTER TABLE conversation_messages DROP COLUMN metadata_json')
  }
  if (msgColNames.has('target_role')) {
    db.exec('ALTER TABLE conversation_messages DROP COLUMN target_role')
  }
}

function migrateConversationMessages(db: Database.Database): void {
  const cols = db.pragma('table_info(conversation_messages)') as Array<{ name: string }>
  const colNames = cols.map((c) => c.name)
  if (colNames.includes('author') && !colNames.includes('author_name')) {
    db.exec('ALTER TABLE conversation_messages RENAME COLUMN author TO author_name')
  }
  if (!colNames.includes('metadata_json')) {
    try {
      db.exec('ALTER TABLE conversation_messages ADD COLUMN metadata_json TEXT')
    } catch {
      /* exists */
    }
  }
  if (!colNames.includes('target_role')) {
    try {
      db.exec('ALTER TABLE conversation_messages ADD COLUMN target_role TEXT')
    } catch {
      /* exists */
    }
  }
}

function createM1Tables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      workspace_id TEXT,
      task_id TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed')),
      handoff_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      checkpoint TEXT,
      checkpoint_at TEXT,
      cc_session_id TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS context_sources (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_path TEXT NOT NULL,
      label TEXT NOT NULL,
      category TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 100,
      is_active INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','decided')),
      created_by TEXT NOT NULL,
      decision_summary TEXT,
      signed_off_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      decided_at TEXT,
      owner_session_id TEXT,
      owner_type TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_participants (
      conversation_id TEXT NOT NULL,
      participant_name TEXT NOT NULL,
      PRIMARY KEY (conversation_id, participant_name),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_message_reads (
      message_id TEXT NOT NULL,
      participant_name TEXT NOT NULL,
      read_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (message_id, participant_name),
      FOREIGN KEY (message_id) REFERENCES conversation_messages(id)
    )
  `)
  db.exec(
    'CREATE INDEX IF NOT EXISTS conv_message_reads_message_idx ON conversation_message_reads (message_id)'
  )
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_links (
      conversation_id TEXT NOT NULL,
      linked_type TEXT NOT NULL,
      linked_id TEXT NOT NULL,
      PRIMARY KEY (conversation_id, linked_type, linked_id),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_actions (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      assignee TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      linked_task_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS inbox_items (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      workspace_id TEXT,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'raw',
      linked_task_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  // P6 (ADR-032 Pillar 6): nullable workspace scope on inbox, filled progressively.
  // Idempotent ALTER for DBs created before this column existed.
  try {
    db.exec('ALTER TABLE inbox_items ADD COLUMN workspace_id TEXT')
  } catch {
    /* exists */
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_index (
      slug TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('project','cross')),
      type TEXT NOT NULL CHECK (type IN ('spike','decision','postmortem','learning','evaluation','feature','code_ref','gotcha')),
      title TEXT NOT NULL,
      file_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_verified_at TEXT NOT NULL,
      embedding_provider_id TEXT,
      embedding_dims INTEGER,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    )
  `)

  // TASK-643: backfill embedding metadata columns for DBs created before they
  // were part of the schema. New columns; vector itself lives in knowledge_vec
  // (sqlite-vec virtual table created by EmbeddingStore at runtime).
  try {
    db.exec('ALTER TABLE knowledge_index ADD COLUMN embedding_provider_id TEXT')
  } catch {
    /* exists */
  }
  try {
    db.exec('ALTER TABLE knowledge_index ADD COLUMN embedding_dims INTEGER')
  } catch {
    /* exists */
  }

  // ADR-022 (TASK-651): workspace-scoped knowledge.
  try {
    db.exec('ALTER TABLE knowledge_index ADD COLUMN workspace_id TEXT REFERENCES workspaces(id)')
  } catch {
    /* exists */
  }

  // TASK-988: widen the knowledge type CHECK to add feature / code_ref / gotcha.
  // Fresh DBs already get the widened CHECK from the CREATE TABLE above; existing
  // DBs carry the old 5-type CHECK baked into their table definition, which
  // CREATE TABLE IF NOT EXISTS cannot alter — recreate following the
  // migrateSessionsStatus pattern.
  migrateKnowledgeTypeCheck(db)

  // TASK-988: code_ref first-class graph node (ADR-NNN unified knowledge graph).
  // Structured projection of a code anchor — identity is (project_id, path, symbol),
  // NOT the slug. SHA is a re-pin attribute, not identity (ADR Pillar 2c): a dup
  // identity write UPDATEs commit_sha rather than inserting a new row. symbol is
  // NULLABLE for file-level refs (.tsx/.md/migrations); the identity index folds
  // NULL → '' via COALESCE so two file-level refs to one path collide as intended.
  // The matching slug also lives in knowledge_index as the human-readable .md note.
  db.exec(`
    CREATE TABLE IF NOT EXISTS code_refs (
      slug TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      workspace_id TEXT,
      path TEXT NOT NULL,
      symbol TEXT,
      line_hint INTEGER,
      commit_sha TEXT,
      created_at TEXT NOT NULL,
      last_verified_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    )
  `)
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_code_refs_identity ON code_refs(project_id, path, COALESCE(symbol, ''))"
  )
  db.exec('CREATE INDEX IF NOT EXISTS idx_code_refs_symbol ON code_refs(project_id, symbol)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_code_refs_path ON code_refs(project_id, path)')

  // TASK-988: TOUCHES edge — task → code_ref carrying a required relation. This is
  // the load-bearing B1 finding: 'modifies' (the task edits the anchor) vs
  // 'reference' (the task reads it as a pattern). No nullable default — every edge
  // declares its relation.
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_code_refs (
      task_id TEXT NOT NULL,
      code_ref_slug TEXT NOT NULL,
      relation TEXT NOT NULL CHECK (relation IN ('modifies','reference')),
      PRIMARY KEY (task_id, code_ref_slug),
      FOREIGN KEY (code_ref_slug) REFERENCES code_refs(slug)
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_task_code_refs_task ON task_code_refs(task_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_task_code_refs_slug ON task_code_refs(code_ref_slug)')

  // TASK-681: MCP tool usage stats (V0). Append-only invocation log.
  // No project/session/args/response/error-message columns by design (privacy + size).
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_invocations (
      id INTEGER PRIMARY KEY,
      tool_name TEXT NOT NULL,
      ts TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      ok INTEGER NOT NULL,
      error_kind TEXT
    )
  `)
}

function createM2Tables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      event_type TEXT NOT NULL,
      payload_json TEXT,
      memory_candidate INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_memories (
      id TEXT PRIMARY KEY,
      scope_type TEXT NOT NULL CHECK (scope_type IN ('user','project','workspace','task')),
      scope_id TEXT NOT NULL,
      memory_type TEXT NOT NULL CHECK (memory_type IN ('episodic','procedural')),
      content TEXT NOT NULL,
      tags TEXT,
      importance INTEGER DEFAULT 50,
      source_session_id TEXT,
      source_event_ids TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      last_recalled_at TEXT,
      recall_count INTEGER DEFAULT 0
    )
  `)
}

// ADR-034: the ADR-027 self-issued OAuth store is gone — Keycloak issues and
// stores tokens now; choda-deck only validates Keycloak JWTs. Drop the legacy
// tables (idempotent) so existing local DBs are cleaned on next boot. Drop the
// referencing tables before oauth_clients to respect the FKs.
function dropLegacyOAuthTables(db: Database.Database): void {
  db.exec('DROP TABLE IF EXISTS oauth_auth_codes')
  db.exec('DROP TABLE IF EXISTS oauth_tokens')
  db.exec('DROP TABLE IF EXISTS oauth_clients')
}

function createIndexes(db: Database.Database): void {
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(project_id, status)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_tags_item ON tags(item_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_relationships_from ON relationships(from_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_relationships_to ON relationships(to_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(project_id, status)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_context_sources_project ON context_sources(project_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_id)')
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_conv_messages_conv ON conversation_messages(conversation_id)'
  )
  db.exec('CREATE INDEX IF NOT EXISTS idx_conv_links_conv ON conversation_links(conversation_id)')
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_conv_participants_conv ON conversation_participants(conversation_id)'
  )
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_conv_actions_conv ON conversation_actions(conversation_id)'
  )
  db.exec('CREATE INDEX IF NOT EXISTS idx_inbox_project ON inbox_items(project_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox_items(project_id, status)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_inbox_workspace ON inbox_items(workspace_id)')
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_conversations_owner_session ON conversations(owner_session_id)'
  )
  db.exec('CREATE INDEX IF NOT EXISTS idx_knowledge_project ON knowledge_index(project_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_knowledge_type ON knowledge_index(project_id, type)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_knowledge_scope ON knowledge_index(project_id, scope)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_knowledge_workspace ON knowledge_index(workspace_id)')
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_tool_invocations_tool_ts ON tool_invocations(tool_name, ts)'
  )
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id, created_at)'
  )
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_agent_memories_scope ON agent_memories(scope_type, scope_id, memory_type)'
  )
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_agent_memories_recall ON agent_memories(importance DESC, recall_count DESC)'
  )
}

// Rename any existing task rows whose ID exceeds COUNTER_SANE_MAX (legacy
// timestamp-style IDs) to fresh sequential IDs. Updates all known FK columns
// that reference task IDs. Idempotent — no-op once no poisoned IDs remain.
function cleanupPoisonedTaskIds(db: Database.Database): void {
  const rows = db.prepare("SELECT id FROM tasks WHERE id GLOB 'TASK-[0-9]*'").all() as Array<{
    id: string
  }>
  const poisoned = rows
    .map((r) => r.id)
    .filter((id) => {
      const n = parseInt(id.slice(5), 10)
      return !isNaN(n) && n > COUNTER_SANE_MAX
    })
  if (poisoned.length === 0) return

  const renameTx = db.transaction((oldIds: string[]) => {
    for (const oldId of oldIds) {
      const row = db
        .prepare(
          `INSERT INTO global_counters (entity_type, last_number) VALUES ('task', 1)
           ON CONFLICT(entity_type) DO UPDATE SET last_number = last_number + 1
           RETURNING last_number`
        )
        .get() as { last_number: number }
      const newId = `TASK-${String(row.last_number).padStart(3, '0')}`
      db.prepare('UPDATE tasks SET id = ? WHERE id = ?').run(newId, oldId)
      db.prepare('UPDATE tasks SET parent_task_id = ? WHERE parent_task_id = ?').run(newId, oldId)
      db.prepare('UPDATE sessions SET task_id = ? WHERE task_id = ?').run(newId, oldId)
      db.prepare(
        "UPDATE conversation_links SET linked_id = ? WHERE linked_type = 'task' AND linked_id = ?"
      ).run(newId, oldId)
      db.prepare('UPDATE conversation_actions SET linked_task_id = ? WHERE linked_task_id = ?').run(
        newId,
        oldId
      )
      db.prepare('UPDATE inbox_items SET linked_task_id = ? WHERE linked_task_id = ?').run(
        newId,
        oldId
      )
      db.prepare('UPDATE tags SET item_id = ? WHERE item_id = ?').run(newId, oldId)
      db.prepare('UPDATE relationships SET from_id = ? WHERE from_id = ?').run(newId, oldId)
      db.prepare('UPDATE relationships SET to_id = ? WHERE to_id = ?').run(newId, oldId)
    }
  })
  renameTx(poisoned)
}
