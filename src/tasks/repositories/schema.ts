import type Database from 'better-sqlite3'

export function initSchema(db: Database.Database): void {
  createCoreTables(db)
  runLegacyMigrations(db)
  createM1Tables(db)
  createIndexes(db)
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
    CREATE TABLE IF NOT EXISTS features (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      phase_id TEXT,
      title TEXT NOT NULL,
      priority TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      feature_id TEXT,
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
  try {
    db.exec('ALTER TABLE tasks ADD COLUMN feature_id TEXT')
  } catch {
    /* exists */
  }

  try {
    db.exec(`
      UPDATE tasks SET feature_id = (
        SELECT e.feature_id FROM epics e WHERE e.id = tasks.epic_id
      ) WHERE epic_id IS NOT NULL AND feature_id IS NULL
    `)
  } catch {
    /* epics table may not exist */
  }

  db.exec('DROP TABLE IF EXISTS epics')
  db.exec('DROP TABLE IF EXISTS task_dependencies')
  try {
    db.exec('DROP INDEX IF EXISTS idx_tasks_epic')
  } catch {
    /* ok */
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
}

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
      if (!isNaN(n) && n > max) max = n
    }
  } catch {
    /* table may not exist yet on first bootstrap */
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
      status TEXT NOT NULL DEFAULT 'active',
      handoff_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
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
}

function createIndexes(db: Database.Database): void {
  db.exec('CREATE INDEX IF NOT EXISTS idx_phases_project ON phases(project_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_features_project ON features(project_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_features_phase ON features(phase_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(project_id, status)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_feature ON tasks(feature_id)')
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
}
