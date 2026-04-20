import type Database from 'better-sqlite3'

export function initSchema(db: Database.Database): void {
  createCoreTables(db)
  runLegacyMigrations(db)
  createM1Tables(db)
  createIndexes(db)
  cleanupPoisonedTaskIds(db)
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
    CREATE TABLE IF NOT EXISTS phases (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      position INTEGER DEFAULT 0,
      target_date TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
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
  try {
    db.exec('ALTER TABLE phases ADD COLUMN start_date TEXT')
  } catch {
    /* exists */
  }
  try {
    db.exec('ALTER TABLE phases ADD COLUMN completed_date TEXT')
  } catch {
    /* exists */
  }
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

  // tasks: direct phase link (Phase → Task hierarchy)
  try {
    db.exec('ALTER TABLE tasks ADD COLUMN phase_id TEXT')
  } catch {
    /* exists */
  }

  // tasks: body content (SQLite becomes source of truth for content)
  try {
    db.exec('ALTER TABLE tasks ADD COLUMN body TEXT')
  } catch {
    /* exists */
  }

  // TASK-538 (ADR-014): harness pipeline columns on sessions
  try {
    db.exec('ALTER TABLE sessions ADD COLUMN pipeline_stage TEXT')
  } catch {
    /* exists */
  }
  try {
    db.exec('ALTER TABLE sessions ADD COLUMN pipeline_stage_status TEXT')
  } catch {
    /* exists */
  }
  try {
    db.exec('ALTER TABLE sessions ADD COLUMN needs_evaluator INTEGER NOT NULL DEFAULT 0')
  } catch {
    /* exists */
  }
  try {
    db.exec('ALTER TABLE sessions ADD COLUMN current_iteration INTEGER NOT NULL DEFAULT 0')
  } catch {
    /* exists */
  }

  // TASK-538 (ADR-014): conversation attribution for R3 reverse-direction guard
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
      pipeline_stage TEXT,
      pipeline_stage_status TEXT,
      needs_evaluator INTEGER NOT NULL DEFAULT 0,
      current_iteration INTEGER NOT NULL DEFAULT 0,
      checkpoint TEXT,
      checkpoint_at TEXT,
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
      status TEXT NOT NULL DEFAULT 'open',
      created_by TEXT NOT NULL,
      decision_summary TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      decided_at TEXT,
      closed_at TEXT,
      owner_session_id TEXT,
      owner_type TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_participants (
      conversation_id TEXT NOT NULL,
      participant_name TEXT NOT NULL,
      participant_type TEXT NOT NULL,
      participant_role TEXT,
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
      message_type TEXT NOT NULL DEFAULT 'comment',
      metadata_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    )
  `)
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
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'raw',
      linked_task_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  // TASK-538 (ADR-014): per-stage human approval log for harness pipeline
  // TASK-557: `diagnostics` carries a JSON-stringified StageDiagnostics on planner failures.
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      iteration INTEGER NOT NULL,
      decision TEXT NOT NULL,
      feedback TEXT,
      diagnostics TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )
  `)
  // Upgrade path for pre-TASK-557 DBs where CREATE TABLE above was a no-op.
  try {
    db.exec('ALTER TABLE pipeline_approvals ADD COLUMN diagnostics TEXT')
  } catch {
    /* exists */
  }
}

function createIndexes(db: Database.Database): void {
  db.exec('CREATE INDEX IF NOT EXISTS idx_phases_project ON phases(project_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(project_id, status)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_phase ON tasks(phase_id)')
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
  db.exec('CREATE INDEX IF NOT EXISTS idx_approvals_session ON pipeline_approvals(session_id)')
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_conversations_owner_session ON conversations(owner_session_id)'
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
