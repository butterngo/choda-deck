var __create = Object.create
var __defProp = Object.defineProperty
var __getOwnPropDesc = Object.getOwnPropertyDescriptor
var __getOwnPropNames = Object.getOwnPropertyNames
var __getProtoOf = Object.getPrototypeOf
var __hasOwnProp = Object.prototype.hasOwnProperty
var __copyProps = (to, from, except, desc) => {
  if ((from && typeof from === 'object') || typeof from === 'function') {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, {
          get: () => from[key],
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
        })
  }
  return to
}
var __toESM = (mod, isNodeMode, target) => (
  (target = mod != null ? __create(__getProtoOf(mod)) : {}),
  __copyProps(
    // If the importer is in node compatibility mode or this is not an ESM
    // file that has been converted to a CommonJS file using a Babel-
    // compatible transform (i.e. "__esModule" has not been set), then set
    // "default" to the CommonJS "module.exports" for node compatibility.
    isNodeMode || !mod || !mod.__esModule
      ? __defProp(target, 'default', { value: mod, enumerable: true })
      : target,
    mod
  )
)

// src/tasks/sqlite-task-service.ts
var import_better_sqlite3 = __toESM(require('better-sqlite3'))

// src/tasks/repositories/schema.ts
function initSchema(db) {
  createCoreTables(db)
  runLegacyMigrations(db)
  createM1Tables(db)
  createIndexes(db)
}
function createCoreTables(db) {
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
function runLegacyMigrations(db) {
  try {
    db.exec('ALTER TABLE phases ADD COLUMN start_date TEXT')
  } catch {}
  try {
    db.exec('ALTER TABLE phases ADD COLUMN completed_date TEXT')
  } catch {}
  try {
    db.exec('ALTER TABLE tasks ADD COLUMN feature_id TEXT')
  } catch {}
  try {
    db.exec(`
      UPDATE tasks SET feature_id = (
        SELECT e.feature_id FROM epics e WHERE e.id = tasks.epic_id
      ) WHERE epic_id IS NOT NULL AND feature_id IS NULL
    `)
  } catch {}
  db.exec('DROP TABLE IF EXISTS epics')
  db.exec('DROP TABLE IF EXISTS task_dependencies')
  try {
    db.exec('DROP INDEX IF EXISTS idx_tasks_epic')
  } catch {}
  try {
    db.exec("ALTER TABLE conversations ADD COLUMN created_by TEXT NOT NULL DEFAULT ''")
  } catch {}
  try {
    db.exec('ALTER TABLE conversations ADD COLUMN decided_at TEXT')
  } catch {}
  try {
    db.exec('ALTER TABLE sessions ADD COLUMN workspace_id TEXT')
  } catch {}
  try {
    db.exec('ALTER TABLE sessions ADD COLUMN task_id TEXT')
  } catch {}
  try {
    db.exec('ALTER TABLE tasks ADD COLUMN phase_id TEXT')
  } catch {}
  migrateConversationMessages(db)
}
function migrateConversationMessages(db) {
  const cols = db.pragma('table_info(conversation_messages)')
  const colNames = cols.map((c) => c.name)
  if (colNames.includes('author') && !colNames.includes('author_name')) {
    db.exec('ALTER TABLE conversation_messages RENAME COLUMN author TO author_name')
  }
  if (!colNames.includes('metadata_json')) {
    try {
      db.exec('ALTER TABLE conversation_messages ADD COLUMN metadata_json TEXT')
    } catch {}
  }
}
function createM1Tables(db) {
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
}
function createIndexes(db) {
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
}

// src/tasks/repositories/project-repository.ts
var ProjectRepository = class {
  constructor(db) {
    this.db = db
  }
  ensure(id, name, cwd) {
    this.db
      .prepare('INSERT OR IGNORE INTO projects (id, name, cwd) VALUES (?, ?, ?)')
      .run(id, name, cwd)
  }
  get(id) {
    const row = this.db.prepare('SELECT id, name, cwd FROM projects WHERE id = ?').get(id)
    return row ?? null
  }
  list() {
    return this.db.prepare('SELECT id, name, cwd FROM projects ORDER BY name').all()
  }
  addWorkspace(projectId, id, label, cwd) {
    this.db
      .prepare('INSERT OR REPLACE INTO workspaces (id, project_id, label, cwd) VALUES (?, ?, ?, ?)')
      .run(id, projectId, label, cwd)
    return { id, projectId, label, cwd }
  }
  getWorkspace(id) {
    const row = this.db
      .prepare('SELECT id, project_id, label, cwd FROM workspaces WHERE id = ?')
      .get(id)
    if (!row) return null
    return { id: row.id, projectId: row.project_id, label: row.label, cwd: row.cwd }
  }
  findWorkspaces(projectId) {
    const rows = this.db
      .prepare(
        'SELECT id, project_id, label, cwd FROM workspaces WHERE project_id = ? ORDER BY label'
      )
      .all(projectId)
    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      label: r.label,
      cwd: r.cwd
    }))
  }
}

// src/tasks/repositories/shared.ts
function now() {
  return /* @__PURE__ */ new Date().toISOString()
}
var idCounter = 0
function generateId(prefix) {
  idCounter += 1
  return `${prefix}-${Date.now()}-${idCounter}`
}
function derivedProgress(total, done, inProgress) {
  const status =
    total === 0
      ? 'planned'
      : done === total
        ? 'completed'
        : done > 0 || inProgress > 0
          ? 'active'
          : 'planned'
  const percent = total === 0 ? 0 : Math.round((done / total) * 100)
  return { total, done, inProgress, status, percent }
}

// src/tasks/repositories/task-repository.ts
function rowToTask(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    phaseId: row.phase_id || null,
    parentTaskId: row.parent_task_id || null,
    title: row.title,
    status: row.status,
    priority: row.priority || null,
    labels: row.labels ? JSON.parse(row.labels) : [],
    dueDate: row.due_date || null,
    pinned: row.pinned === 1,
    filePath: row.file_path || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}
var TaskRepository = class {
  constructor(db, relationships) {
    this.db = db
    this.relationships = relationships
  }
  nextTaskId(projectId) {
    const rows = this.db
      .prepare("SELECT id FROM tasks WHERE project_id = ? AND id GLOB 'TASK-[0-9]*'")
      .all(projectId)
    let max = 0
    for (const { id } of rows) {
      const n = parseInt(id.slice(5), 10)
      if (!isNaN(n) && n > max) max = n
    }
    return `TASK-${String(max + 1).padStart(3, '0')}`
  }
  create(input) {
    const ts = now()
    const id = input.id || this.nextTaskId(input.projectId)
    this.db
      .prepare(
        `INSERT INTO tasks (id, project_id, phase_id, parent_task_id, title, status, priority, labels, due_date, file_path, pinned, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      )
      .run(
        id,
        input.projectId,
        input.phaseId || null,
        input.parentTaskId || null,
        input.title,
        input.status || 'TODO',
        input.priority || null,
        input.labels ? JSON.stringify(input.labels) : null,
        input.dueDate || null,
        input.filePath || null,
        ts,
        ts
      )
    return this.get(id)
  }
  update(id, input) {
    const sets = ['updated_at = ?']
    const params = [now()]
    if (input.title !== void 0) {
      sets.push('title = ?')
      params.push(input.title)
    }
    if (input.status !== void 0) {
      sets.push('status = ?')
      params.push(input.status)
    }
    if (input.priority !== void 0) {
      sets.push('priority = ?')
      params.push(input.priority)
    }
    if (input.phaseId !== void 0) {
      sets.push('phase_id = ?')
      params.push(input.phaseId)
    }
    if (input.parentTaskId !== void 0) {
      sets.push('parent_task_id = ?')
      params.push(input.parentTaskId)
    }
    if (input.labels !== void 0) {
      sets.push('labels = ?')
      params.push(JSON.stringify(input.labels))
    }
    if (input.dueDate !== void 0) {
      sets.push('due_date = ?')
      params.push(input.dueDate)
    }
    if (input.pinned !== void 0) {
      sets.push('pinned = ?')
      params.push(input.pinned ? 1 : 0)
    }
    if (input.filePath !== void 0) {
      sets.push('file_path = ?')
      params.push(input.filePath)
    }
    params.push(id)
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    const task = this.get(id)
    if (!task) throw new Error(`Task not found: ${id}`)
    return task
  }
  delete(id) {
    this.db.prepare('DELETE FROM relationships WHERE from_id = ? OR to_id = ?').run(id, id)
    this.db.prepare('DELETE FROM tags WHERE item_id = ?').run(id)
    this.db.prepare('UPDATE tasks SET parent_task_id = NULL WHERE parent_task_id = ?').run(id)
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
  }
  get(id) {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
    return row ? rowToTask(row) : null
  }
  find(filter) {
    const { sql, params } = buildTaskQuery(filter)
    const rows = this.db.prepare(sql).all(...params)
    return rows.map(rowToTask)
  }
  getSubtasks(parentId) {
    const rows = this.db
      .prepare('SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY created_at')
      .all(parentId)
    return rows.map(rowToTask)
  }
  getPinned() {
    const rows = this.db
      .prepare('SELECT * FROM tasks WHERE pinned = 1 ORDER BY project_id, created_at')
      .all()
    return rows.map(rowToTask)
  }
  getDue(date) {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE due_date <= ? AND status != 'DONE' ORDER BY due_date")
      .all(date)
    return rows.map(rowToTask)
  }
  // Dependencies backed by the relationships table
  addDependency(sourceId, targetId) {
    this.relationships.add(sourceId, targetId, 'DEPENDS_ON')
  }
  removeDependency(sourceId, targetId) {
    this.relationships.remove(sourceId, targetId, 'DEPENDS_ON')
  }
  getDependencies(taskId) {
    const rows = this.db
      .prepare(
        "SELECT from_id, to_id FROM relationships WHERE (from_id = ? OR to_id = ?) AND type = 'DEPENDS_ON'"
      )
      .all(taskId, taskId)
    return rows.map((row) => ({ sourceId: row.from_id, targetId: row.to_id }))
  }
}
function buildTaskQuery(filter) {
  const wheres = []
  const params = []
  if (filter.projectId) {
    wheres.push('project_id = ?')
    params.push(filter.projectId)
  }
  if (filter.status) {
    wheres.push('status = ?')
    params.push(filter.status)
  }
  if (filter.priority) {
    wheres.push('priority = ?')
    params.push(filter.priority)
  }
  if (filter.phaseId) {
    wheres.push('phase_id = ?')
    params.push(filter.phaseId)
  }
  if (filter.parentTaskId) {
    wheres.push('parent_task_id = ?')
    params.push(filter.parentTaskId)
  }
  if (filter.pinned) {
    wheres.push('pinned = 1')
  }
  if (filter.dueBefore) {
    wheres.push('due_date <= ?')
    params.push(filter.dueBefore)
  }
  if (filter.query) {
    wheres.push('title LIKE ?')
    params.push(`%${filter.query}%`)
  }
  const where = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : ''
  const limit = filter.limit ? `LIMIT ${filter.limit}` : ''
  return { sql: `SELECT * FROM tasks ${where} ORDER BY created_at DESC ${limit}`, params }
}

// src/tasks/repositories/phase-repository.ts
function rowToPhase(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    position: row.position || 0,
    startDate: row.start_date || null,
    completedDate: row.completed_date || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}
var PhaseRepository = class {
  constructor(db) {
    this.db = db
  }
  create(input) {
    const ts = now()
    const id = input.id || generateId('PHASE')
    this.db
      .prepare(
        'INSERT INTO phases (id, project_id, title, status, position, start_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        id,
        input.projectId,
        input.title,
        input.status || 'open',
        input.position || 0,
        input.startDate || null,
        ts,
        ts
      )
    return this.get(id)
  }
  update(id, input) {
    const sets = ['updated_at = ?']
    const params = [now()]
    if (input.title !== void 0) {
      sets.push('title = ?')
      params.push(input.title)
    }
    if (input.status !== void 0) {
      sets.push('status = ?')
      params.push(input.status)
    }
    if (input.position !== void 0) {
      sets.push('position = ?')
      params.push(input.position)
    }
    if (input.startDate !== void 0) {
      sets.push('start_date = ?')
      params.push(input.startDate)
    }
    if (input.completedDate !== void 0) {
      sets.push('completed_date = ?')
      params.push(input.completedDate)
    }
    params.push(id)
    this.db.prepare(`UPDATE phases SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    const phase = this.get(id)
    if (!phase) throw new Error(`Phase not found: ${id}`)
    return phase
  }
  delete(id) {
    this.db.prepare('UPDATE features SET phase_id = NULL WHERE phase_id = ?').run(id)
    this.db.prepare('UPDATE tasks SET phase_id = NULL WHERE phase_id = ?').run(id)
    this.db.prepare('DELETE FROM phases WHERE id = ?').run(id)
  }
  get(id) {
    const row = this.db.prepare('SELECT * FROM phases WHERE id = ?').get(id)
    return row ? rowToPhase(row) : null
  }
  findByProject(projectId) {
    const rows = this.db
      .prepare('SELECT * FROM phases WHERE project_id = ? ORDER BY position')
      .all(projectId)
    return rows.map(rowToPhase)
  }
  getProgress(phaseId) {
    const phase = this.get(phaseId)
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as total,
              SUM(CASE WHEN t.status = 'DONE' THEN 1 ELSE 0 END) as done,
              SUM(CASE WHEN t.status = 'IN-PROGRESS' THEN 1 ELSE 0 END) as ip
       FROM tasks t
       WHERE t.phase_id = ?`
      )
      .get(phaseId)
    const total = row?.total || 0
    const done = row?.done || 0
    const inProgress = row?.ip || 0
    const percent = total === 0 ? 0 : Math.round((done / total) * 100)
    const status = this.deriveProgressStatus(phase, total, done)
    return { total, done, inProgress, status, percent }
  }
  deriveProgressStatus(phase, total, done) {
    if (total > 0 && done === total) {
      if (phase && !phase.completedDate) {
        this.update(phase.id, { completedDate: now().split('T')[0] })
      }
      return 'completed'
    }
    if (phase?.startDate) {
      if (phase.completedDate) {
        this.update(phase.id, { completedDate: null })
      }
      return 'active'
    }
    return 'planned'
  }
}

// src/tasks/repositories/feature-repository.ts
function rowToFeature(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    phaseId: row.phase_id || null,
    title: row.title,
    priority: row.priority || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}
var FeatureRepository = class {
  constructor(db) {
    this.db = db
  }
  create(input) {
    const ts = now()
    const id = input.id || generateId('FEAT')
    this.db
      .prepare(
        'INSERT INTO features (id, project_id, phase_id, title, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(id, input.projectId, input.phaseId || null, input.title, input.priority || null, ts, ts)
    return this.get(id)
  }
  update(id, input) {
    const sets = ['updated_at = ?']
    const params = [now()]
    if (input.title !== void 0) {
      sets.push('title = ?')
      params.push(input.title)
    }
    if (input.phaseId !== void 0) {
      sets.push('phase_id = ?')
      params.push(input.phaseId)
    }
    if (input.priority !== void 0) {
      sets.push('priority = ?')
      params.push(input.priority)
    }
    params.push(id)
    this.db.prepare(`UPDATE features SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    const feature = this.get(id)
    if (!feature) throw new Error(`Feature not found: ${id}`)
    return feature
  }
  delete(id) {
    this.db.prepare('UPDATE tasks SET feature_id = NULL WHERE feature_id = ?').run(id)
    this.db.prepare('DELETE FROM features WHERE id = ?').run(id)
  }
  get(id) {
    const row = this.db.prepare('SELECT * FROM features WHERE id = ?').get(id)
    return row ? rowToFeature(row) : null
  }
  findByProject(projectId) {
    const rows = this.db
      .prepare('SELECT * FROM features WHERE project_id = ? ORDER BY created_at')
      .all(projectId)
    return rows.map(rowToFeature)
  }
  findByPhase(phaseId) {
    const rows = this.db
      .prepare('SELECT * FROM features WHERE phase_id = ? ORDER BY created_at')
      .all(phaseId)
    return rows.map(rowToFeature)
  }
  getProgress(featureId) {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as total,
              SUM(CASE WHEN status = 'DONE' THEN 1 ELSE 0 END) as done,
              SUM(CASE WHEN status = 'IN-PROGRESS' THEN 1 ELSE 0 END) as ip
       FROM tasks WHERE feature_id = ?`
      )
      .get(featureId)
    if (!row) return derivedProgress(0, 0, 0)
    return derivedProgress(row.total || 0, row.done || 0, row.ip || 0)
  }
}

// src/tasks/repositories/document-repository.ts
function rowToDocument(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    title: row.title,
    filePath: row.file_path || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}
var DocumentRepository = class {
  constructor(db) {
    this.db = db
  }
  create(input) {
    const ts = now()
    const id = input.id || generateId('DOC')
    this.db
      .prepare(
        'INSERT INTO documents (id, project_id, type, title, file_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(id, input.projectId, input.type, input.title, input.filePath || null, ts, ts)
    return this.get(id)
  }
  update(id, input) {
    const sets = ['updated_at = ?']
    const params = [now()]
    if (input.title !== void 0) {
      sets.push('title = ?')
      params.push(input.title)
    }
    if (input.type !== void 0) {
      sets.push('type = ?')
      params.push(input.type)
    }
    if (input.filePath !== void 0) {
      sets.push('file_path = ?')
      params.push(input.filePath)
    }
    params.push(id)
    this.db.prepare(`UPDATE documents SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    const doc = this.get(id)
    if (!doc) throw new Error(`Document not found: ${id}`)
    return doc
  }
  delete(id) {
    this.db.prepare('DELETE FROM tags WHERE item_id = ?').run(id)
    this.db.prepare('DELETE FROM documents WHERE id = ?').run(id)
  }
  get(id) {
    const row = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id)
    return row ? rowToDocument(row) : null
  }
  findByProject(projectId, type) {
    const rows = type
      ? this.db
          .prepare('SELECT * FROM documents WHERE project_id = ? AND type = ? ORDER BY created_at')
          .all(projectId, type)
      : this.db
          .prepare('SELECT * FROM documents WHERE project_id = ? ORDER BY type, created_at')
          .all(projectId)
    return rows.map(rowToDocument)
  }
}

// src/tasks/repositories/tag-repository.ts
var TagRepository = class {
  constructor(db) {
    this.db = db
  }
  add(itemId, tag) {
    this.db.prepare('INSERT OR IGNORE INTO tags (item_id, tag) VALUES (?, ?)').run(itemId, tag)
  }
  remove(itemId, tag) {
    this.db.prepare('DELETE FROM tags WHERE item_id = ? AND tag = ?').run(itemId, tag)
  }
  getForItem(itemId) {
    const rows = this.db.prepare('SELECT tag FROM tags WHERE item_id = ? ORDER BY tag').all(itemId)
    return rows.map((row) => row.tag)
  }
  findItemsByTag(tag) {
    const rows = this.db.prepare('SELECT item_id FROM tags WHERE tag = ? ORDER BY item_id').all(tag)
    return rows.map((row) => row.item_id)
  }
}

// src/tasks/repositories/relationship-repository.ts
function rowToRelationship(row) {
  return { fromId: row.from_id, toId: row.to_id, type: row.type }
}
var RelationshipRepository = class {
  constructor(db) {
    this.db = db
  }
  add(fromId, toId, type) {
    this.db
      .prepare('INSERT OR IGNORE INTO relationships (from_id, to_id, type) VALUES (?, ?, ?)')
      .run(fromId, toId, type)
  }
  remove(fromId, toId, type) {
    this.db
      .prepare('DELETE FROM relationships WHERE from_id = ? AND to_id = ? AND type = ?')
      .run(fromId, toId, type)
  }
  getForItem(itemId) {
    const rows = this.db
      .prepare('SELECT * FROM relationships WHERE from_id = ? OR to_id = ?')
      .all(itemId, itemId)
    return rows.map(rowToRelationship)
  }
  getFrom(itemId, type) {
    const rows = type
      ? this.db
          .prepare('SELECT * FROM relationships WHERE from_id = ? AND type = ?')
          .all(itemId, type)
      : this.db.prepare('SELECT * FROM relationships WHERE from_id = ?').all(itemId)
    return rows.map(rowToRelationship)
  }
}

// src/tasks/repositories/session-repository.ts
function rowToSession(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    workspaceId: row.workspace_id || null,
    taskId: row.task_id || null,
    startedAt: row.started_at,
    endedAt: row.ended_at || null,
    status: row.status,
    handoff: row.handoff_json ? JSON.parse(row.handoff_json) : null,
    createdAt: row.created_at
  }
}
var SessionRepository = class {
  constructor(db) {
    this.db = db
  }
  create(input) {
    const ts = now()
    const id = input.id || generateId('SESSION')
    const startedAt = input.startedAt || ts
    this.db
      .prepare(
        `INSERT INTO sessions (id, project_id, workspace_id, task_id, started_at, status, handoff_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.projectId,
        input.workspaceId || null,
        input.taskId || null,
        startedAt,
        input.status || 'active',
        input.handoff ? JSON.stringify(input.handoff) : null,
        ts
      )
    return this.get(id)
  }
  update(id, input) {
    const sets = []
    const params = []
    if (input.endedAt !== void 0) {
      sets.push('ended_at = ?')
      params.push(input.endedAt)
    }
    if (input.status !== void 0) {
      sets.push('status = ?')
      params.push(input.status)
    }
    if (input.taskId !== void 0) {
      sets.push('task_id = ?')
      params.push(input.taskId)
    }
    if (input.handoff !== void 0) {
      sets.push('handoff_json = ?')
      params.push(input.handoff === null ? null : JSON.stringify(input.handoff))
    }
    if (sets.length === 0) {
      const s2 = this.get(id)
      if (!s2) throw new Error(`Session not found: ${id}`)
      return s2
    }
    params.push(id)
    this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    const s = this.get(id)
    if (!s) throw new Error(`Session not found: ${id}`)
    return s
  }
  get(id) {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id)
    return row ? rowToSession(row) : null
  }
  findByProject(projectId, status) {
    const rows = status
      ? this.db
          .prepare(
            'SELECT * FROM sessions WHERE project_id = ? AND status = ? ORDER BY started_at DESC'
          )
          .all(projectId, status)
      : this.db
          .prepare('SELECT * FROM sessions WHERE project_id = ? ORDER BY started_at DESC')
          .all(projectId)
    return rows.map(rowToSession)
  }
  getActive(projectId, workspaceId) {
    const sql = workspaceId
      ? "SELECT * FROM sessions WHERE project_id = ? AND workspace_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1"
      : "SELECT * FROM sessions WHERE project_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1"
    const params = workspaceId ? [projectId, workspaceId] : [projectId]
    const row = this.db.prepare(sql).get(...params)
    return row ? rowToSession(row) : null
  }
  delete(id) {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  }
}

// src/tasks/repositories/context-source-repository.ts
function rowToContextSource(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceType: row.source_type,
    sourcePath: row.source_path,
    label: row.label,
    category: row.category,
    priority: row.priority,
    isActive: row.is_active === 1
  }
}
var ContextSourceRepository = class {
  constructor(db) {
    this.db = db
  }
  create(input) {
    const id = input.id || generateId('CTXSRC')
    this.db
      .prepare(
        `INSERT INTO context_sources (id, project_id, source_type, source_path, label, category, priority, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.projectId,
        input.sourceType,
        input.sourcePath,
        input.label,
        input.category,
        input.priority ?? 100,
        input.isActive === false ? 0 : 1
      )
    return this.get(id)
  }
  update(id, input) {
    const sets = []
    const params = []
    if (input.sourceType !== void 0) {
      sets.push('source_type = ?')
      params.push(input.sourceType)
    }
    if (input.sourcePath !== void 0) {
      sets.push('source_path = ?')
      params.push(input.sourcePath)
    }
    if (input.label !== void 0) {
      sets.push('label = ?')
      params.push(input.label)
    }
    if (input.category !== void 0) {
      sets.push('category = ?')
      params.push(input.category)
    }
    if (input.priority !== void 0) {
      sets.push('priority = ?')
      params.push(input.priority)
    }
    if (input.isActive !== void 0) {
      sets.push('is_active = ?')
      params.push(input.isActive ? 1 : 0)
    }
    if (sets.length === 0) {
      const s2 = this.get(id)
      if (!s2) throw new Error(`ContextSource not found: ${id}`)
      return s2
    }
    params.push(id)
    this.db.prepare(`UPDATE context_sources SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    const s = this.get(id)
    if (!s) throw new Error(`ContextSource not found: ${id}`)
    return s
  }
  get(id) {
    const row = this.db.prepare('SELECT * FROM context_sources WHERE id = ?').get(id)
    return row ? rowToContextSource(row) : null
  }
  findByProject(projectId, activeOnly = false) {
    const sql = activeOnly
      ? 'SELECT * FROM context_sources WHERE project_id = ? AND is_active = 1 ORDER BY priority, label'
      : 'SELECT * FROM context_sources WHERE project_id = ? ORDER BY priority, label'
    const rows = this.db.prepare(sql).all(projectId)
    return rows.map(rowToContextSource)
  }
  delete(id) {
    this.db.prepare('DELETE FROM context_sources WHERE id = ?').run(id)
  }
}

// src/tasks/repositories/conversation-repository.ts
function rowToConversation(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    createdBy: row.created_by,
    decisionSummary: row.decision_summary || null,
    createdAt: row.created_at,
    decidedAt: row.decided_at || null,
    closedAt: row.closed_at || null
  }
}
function rowToParticipant(row) {
  return {
    conversationId: row.conversation_id,
    name: row.participant_name,
    type: row.participant_type,
    role: row.participant_role || null
  }
}
function rowToMessage(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    authorName: row.author_name,
    content: row.content,
    messageType: row.message_type,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null,
    createdAt: row.created_at
  }
}
function rowToAction(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    assignee: row.assignee,
    description: row.description,
    status: row.status,
    linkedTaskId: row.linked_task_id || null,
    createdAt: row.created_at
  }
}
var ConversationRepository = class {
  constructor(db) {
    this.db = db
  }
  // ── Conversations ──────────────────────────────────────────────────────────
  create(input) {
    const id = input.id || generateId('CONV')
    this.db
      .prepare(
        `INSERT INTO conversations (id, project_id, title, status, created_by)
       VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, input.projectId, input.title, input.status || 'open', input.createdBy)
    if (input.participants) {
      for (const p of input.participants) {
        this.addParticipant(id, p.name, p.type, p.role)
      }
    }
    return this.get(id)
  }
  update(id, input) {
    const sets = []
    const params = []
    if (input.title !== void 0) {
      sets.push('title = ?')
      params.push(input.title)
    }
    if (input.status !== void 0) {
      sets.push('status = ?')
      params.push(input.status)
    }
    if (input.decisionSummary !== void 0) {
      sets.push('decision_summary = ?')
      params.push(input.decisionSummary)
    }
    if (input.decidedAt !== void 0) {
      sets.push('decided_at = ?')
      params.push(input.decidedAt)
    }
    if (input.closedAt !== void 0) {
      sets.push('closed_at = ?')
      params.push(input.closedAt)
    }
    if (sets.length === 0) return this.requireGet(id)
    params.push(id)
    this.db.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    return this.requireGet(id)
  }
  get(id) {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id)
    return row ? rowToConversation(row) : null
  }
  findByProject(projectId, status) {
    const rows = status
      ? this.db
          .prepare(
            'SELECT * FROM conversations WHERE project_id = ? AND status = ? ORDER BY created_at DESC'
          )
          .all(projectId, status)
      : this.db
          .prepare('SELECT * FROM conversations WHERE project_id = ? ORDER BY created_at DESC')
          .all(projectId)
    return rows.map(rowToConversation)
  }
  delete(id) {
    this.db.prepare('DELETE FROM conversation_actions WHERE conversation_id = ?').run(id)
    this.db.prepare('DELETE FROM conversation_links WHERE conversation_id = ?').run(id)
    this.db.prepare('DELETE FROM conversation_messages WHERE conversation_id = ?').run(id)
    this.db.prepare('DELETE FROM conversation_participants WHERE conversation_id = ?').run(id)
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
  }
  requireGet(id) {
    const c = this.get(id)
    if (!c) throw new Error(`Conversation not found: ${id}`)
    return c
  }
  // ── Participants ───────────────────────────────────────────────────────────
  addParticipant(conversationId, name, type, role) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO conversation_participants
       (conversation_id, participant_name, participant_type, participant_role)
       VALUES (?, ?, ?, ?)`
      )
      .run(conversationId, name, type, role ?? null)
  }
  removeParticipant(conversationId, name) {
    this.db
      .prepare(
        'DELETE FROM conversation_participants WHERE conversation_id = ? AND participant_name = ?'
      )
      .run(conversationId, name)
  }
  getParticipants(conversationId) {
    const rows = this.db
      .prepare(
        'SELECT * FROM conversation_participants WHERE conversation_id = ? ORDER BY participant_name'
      )
      .all(conversationId)
    return rows.map(rowToParticipant)
  }
  // ── Messages ───────────────────────────────────────────────────────────────
  addMessage(input) {
    const id = input.id || generateId('MSG')
    this.db
      .prepare(
        `INSERT INTO conversation_messages
       (id, conversation_id, author_name, content, message_type, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.conversationId,
        input.authorName,
        input.content,
        input.messageType || 'comment',
        input.metadata ? JSON.stringify(input.metadata) : null
      )
    const row = this.db.prepare('SELECT * FROM conversation_messages WHERE id = ?').get(id)
    return rowToMessage(row)
  }
  getMessages(conversationId) {
    const rows = this.db
      .prepare(
        'SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at, id'
      )
      .all(conversationId)
    return rows.map(rowToMessage)
  }
  // ── Actions ────────────────────────────────────────────────────────────────
  addAction(input) {
    const id = input.id || generateId('ACT')
    this.db
      .prepare(
        `INSERT INTO conversation_actions
       (id, conversation_id, assignee, description, status, linked_task_id)
       VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.conversationId,
        input.assignee,
        input.description,
        input.status || 'pending',
        input.linkedTaskId || null
      )
    const row = this.db.prepare('SELECT * FROM conversation_actions WHERE id = ?').get(id)
    return rowToAction(row)
  }
  updateAction(id, input) {
    const sets = []
    const params = []
    if (input.status !== void 0) {
      sets.push('status = ?')
      params.push(input.status)
    }
    if (input.linkedTaskId !== void 0) {
      sets.push('linked_task_id = ?')
      params.push(input.linkedTaskId)
    }
    if (sets.length > 0) {
      params.push(id)
      this.db
        .prepare(`UPDATE conversation_actions SET ${sets.join(', ')} WHERE id = ?`)
        .run(...params)
    }
    const row = this.db.prepare('SELECT * FROM conversation_actions WHERE id = ?').get(id)
    if (!row) throw new Error(`ConversationAction not found: ${id}`)
    return rowToAction(row)
  }
  getActions(conversationId) {
    const rows = this.db
      .prepare(
        'SELECT * FROM conversation_actions WHERE conversation_id = ? ORDER BY created_at, id'
      )
      .all(conversationId)
    return rows.map(rowToAction)
  }
  // ── Links ──────────────────────────────────────────────────────────────────
  link(conversationId, linkedType, linkedId) {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO conversation_links (conversation_id, linked_type, linked_id) VALUES (?, ?, ?)'
      )
      .run(conversationId, linkedType, linkedId)
  }
  unlink(conversationId, linkedType, linkedId) {
    this.db
      .prepare(
        'DELETE FROM conversation_links WHERE conversation_id = ? AND linked_type = ? AND linked_id = ?'
      )
      .run(conversationId, linkedType, linkedId)
  }
  getLinks(conversationId) {
    const rows = this.db
      .prepare('SELECT * FROM conversation_links WHERE conversation_id = ?')
      .all(conversationId)
    return rows.map((r) => ({
      conversationId: r.conversation_id,
      linkedType: r.linked_type,
      linkedId: r.linked_id
    }))
  }
  findByLink(linkedType, linkedId) {
    const rows = this.db
      .prepare(
        `SELECT c.* FROM conversations c
       JOIN conversation_links l ON l.conversation_id = c.id
       WHERE l.linked_type = ? AND l.linked_id = ?
       ORDER BY c.created_at DESC`
      )
      .all(linkedType, linkedId)
    return rows.map(rowToConversation)
  }
}

// src/tasks/sqlite-task-service.ts
var SqliteTaskService = class {
  db
  projects
  tasks
  phases
  features
  documents
  tagsRepo
  relationships
  sessions
  contextSources
  conversations
  constructor(dbPath) {
    this.db = new import_better_sqlite3.default(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    initSchema(this.db)
    this.projects = new ProjectRepository(this.db)
    this.relationships = new RelationshipRepository(this.db)
    this.tasks = new TaskRepository(this.db, this.relationships)
    this.phases = new PhaseRepository(this.db)
    this.features = new FeatureRepository(this.db)
    this.documents = new DocumentRepository(this.db)
    this.tagsRepo = new TagRepository(this.db)
    this.sessions = new SessionRepository(this.db)
    this.contextSources = new ContextSourceRepository(this.db)
    this.conversations = new ConversationRepository(this.db)
  }
  // ── Lifecycle ──────────────────────────────────────────────────────────────
  initialize() {}
  async initializeAsync() {}
  close() {
    this.db.close()
  }
  ensureProject(id, name, cwd) {
    this.projects.ensure(id, name, cwd)
  }
  getProject(id) {
    return this.projects.get(id)
  }
  listProjects() {
    return this.projects.list()
  }
  addWorkspace(projectId, id, label, cwd) {
    return this.projects.addWorkspace(projectId, id, label, cwd)
  }
  getWorkspace(id) {
    return this.projects.getWorkspace(id)
  }
  findWorkspaces(projectId) {
    return this.projects.findWorkspaces(projectId)
  }
  // ── Task operations ────────────────────────────────────────────────────────
  createTask(input) {
    return this.tasks.create(input)
  }
  updateTask(id, input) {
    return this.tasks.update(id, input)
  }
  deleteTask(id) {
    this.tasks.delete(id)
  }
  getTask(id) {
    return this.tasks.get(id)
  }
  findTasks(filter) {
    return this.tasks.find(filter)
  }
  getSubtasks(parentId) {
    return this.tasks.getSubtasks(parentId)
  }
  getPinnedTasks() {
    return this.tasks.getPinned()
  }
  getDueTasks(date) {
    return this.tasks.getDue(date)
  }
  addDependency(sourceId, targetId) {
    this.tasks.addDependency(sourceId, targetId)
  }
  removeDependency(sourceId, targetId) {
    this.tasks.removeDependency(sourceId, targetId)
  }
  getDependencies(taskId) {
    return this.tasks.getDependencies(taskId)
  }
  // ── Phase operations ───────────────────────────────────────────────────────
  createPhase(input) {
    return this.phases.create(input)
  }
  updatePhase(id, input) {
    return this.phases.update(id, input)
  }
  deletePhase(id) {
    this.phases.delete(id)
  }
  getPhase(id) {
    return this.phases.get(id)
  }
  findPhases(projectId) {
    return this.phases.findByProject(projectId)
  }
  getPhaseProgress(phaseId) {
    return this.phases.getProgress(phaseId)
  }
  // ── Feature operations ─────────────────────────────────────────────────────
  createFeature(input) {
    return this.features.create(input)
  }
  updateFeature(id, input) {
    return this.features.update(id, input)
  }
  deleteFeature(id) {
    this.features.delete(id)
  }
  getFeature(id) {
    return this.features.get(id)
  }
  findFeatures(projectId) {
    return this.features.findByProject(projectId)
  }
  findFeaturesByPhase(phaseId) {
    return this.features.findByPhase(phaseId)
  }
  getFeatureProgress(featureId) {
    return this.features.getProgress(featureId)
  }
  // ── Document operations ────────────────────────────────────────────────────
  createDocument(input) {
    return this.documents.create(input)
  }
  updateDocument(id, input) {
    return this.documents.update(id, input)
  }
  deleteDocument(id) {
    this.documents.delete(id)
  }
  getDocument(id) {
    return this.documents.get(id)
  }
  findDocuments(projectId, type) {
    return this.documents.findByProject(projectId, type)
  }
  // ── Tags ───────────────────────────────────────────────────────────────────
  addTag(itemId, tag) {
    this.tagsRepo.add(itemId, tag)
  }
  removeTag(itemId, tag) {
    this.tagsRepo.remove(itemId, tag)
  }
  getTags(itemId) {
    return this.tagsRepo.getForItem(itemId)
  }
  findByTag(tag) {
    return this.tagsRepo.findItemsByTag(tag)
  }
  // ── Relationships ──────────────────────────────────────────────────────────
  addRelationship(fromId, toId, type) {
    this.relationships.add(fromId, toId, type)
  }
  removeRelationship(fromId, toId, type) {
    this.relationships.remove(fromId, toId, type)
  }
  getRelationships(itemId) {
    return this.relationships.getForItem(itemId)
  }
  getRelationshipsFrom(itemId, type) {
    return this.relationships.getFrom(itemId, type)
  }
  // ── Session operations (M1) ────────────────────────────────────────────────
  createSession(input) {
    return this.sessions.create(input)
  }
  updateSession(id, input) {
    return this.sessions.update(id, input)
  }
  getSession(id) {
    return this.sessions.get(id)
  }
  findSessions(projectId, status) {
    return this.sessions.findByProject(projectId, status)
  }
  getActiveSession(projectId, workspaceId) {
    return this.sessions.getActive(projectId, workspaceId)
  }
  deleteSession(id) {
    this.sessions.delete(id)
  }
  // ── Context source operations (M1) ─────────────────────────────────────────
  createContextSource(input) {
    return this.contextSources.create(input)
  }
  updateContextSource(id, input) {
    return this.contextSources.update(id, input)
  }
  getContextSource(id) {
    return this.contextSources.get(id)
  }
  findContextSources(projectId, activeOnly = false) {
    return this.contextSources.findByProject(projectId, activeOnly)
  }
  deleteContextSource(id) {
    this.contextSources.delete(id)
  }
  // ── Conversation operations (M1) ───────────────────────────────────────────
  createConversation(input) {
    return this.conversations.create(input)
  }
  updateConversation(id, input) {
    return this.conversations.update(id, input)
  }
  getConversation(id) {
    return this.conversations.get(id)
  }
  findConversations(projectId, status) {
    return this.conversations.findByProject(projectId, status)
  }
  deleteConversation(id) {
    this.conversations.delete(id)
  }
  addConversationParticipant(conversationId, name, type, role) {
    this.conversations.addParticipant(conversationId, name, type, role)
  }
  removeConversationParticipant(conversationId, name) {
    this.conversations.removeParticipant(conversationId, name)
  }
  getConversationParticipants(conversationId) {
    return this.conversations.getParticipants(conversationId)
  }
  addConversationMessage(input) {
    return this.conversations.addMessage(input)
  }
  getConversationMessages(conversationId) {
    return this.conversations.getMessages(conversationId)
  }
  addConversationAction(input) {
    return this.conversations.addAction(input)
  }
  updateConversationAction(id, input) {
    return this.conversations.updateAction(id, input)
  }
  getConversationActions(conversationId) {
    return this.conversations.getActions(conversationId)
  }
  linkConversation(conversationId, linkedType, linkedId) {
    this.conversations.link(conversationId, linkedType, linkedId)
  }
  unlinkConversation(conversationId, linkedType, linkedId) {
    this.conversations.unlink(conversationId, linkedType, linkedId)
  }
  getConversationLinks(conversationId) {
    return this.conversations.getLinks(conversationId)
  }
  findConversationsByLink(linkedType, linkedId) {
    return this.conversations.findByLink(linkedType, linkedId)
  }
}

// scripts/_conv-create.ts
var DB_PATH = process.env.CHODA_DB_PATH || 'C:\\dev\\choda-deck\\choda-deck.db'
var svc = new SqliteTaskService(DB_PATH)
var conv = svc.createConversation({
  projectId: 'automation-rule',
  title:
    'task_list kh\xF4ng hi\u1EC3n th\u1ECB TODO tasks khi kh\xF4ng filter \u2014 vault sync gap',
  createdBy: 'Butter',
  status: 'open',
  participants: [
    { name: 'Butter', type: 'human' },
    { name: 'Claude', type: 'agent' }
  ]
})
svc.addConversationMessage({
  conversationId: conv.id,
  authorName: 'Butter',
  content:
    'Ch\u1EA1y task_list t\u1EEB choda-tasks MCP kh\xF4ng th\u1EA5y TASK-157, 159, 161, 162, 138, 141, 134 \u2014 c\u1EA3 TODO l\u1EABn DONE \u0111\u1EC1u kh\xF4ng c\xF3. Nh\u1EEFng task n\xE0y ch\u1EC9 t\u1ED3n t\u1EA1i trong daily note.',
  messageType: 'question'
})
svc.addConversationMessage({
  conversationId: conv.id,
  authorName: 'Claude',
  content:
    '7 task \u0111\xF3 th\u1EF1c ra c\xF3 trong DB v\u1EDBi status TODO. Root cause: (1) import script l\u1ED7i path escaping (backslash) n\xEAn l\u1EA7n \u0111\u1EA7u import kh\xF4ng ch\u1EA1y, (2) extractId regex ch\u1EC9 match TASK-\\d+ n\xEAn timestamp IDs b\u1ECB truncated t\u1EA1o ghost records. \u0110\xE3 fix c\u1EA3 2 v\xE0 re-import. task_list kh\xF4ng filter s\u1EBD th\u1EA5y \u0111\u1EE7 29 TODO tasks.',
  messageType: 'answer'
})
console.log('Created conversation:', JSON.stringify(conv, null, 2))
svc.close()
