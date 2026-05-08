import type Database from 'better-sqlite3'

/**
 * Project-scoped dump of all tables that participate in a sync snapshot.
 *
 * Each domain file maps to one top-level field here. Sub-tables that share
 * the same conceptual entity (e.g. conversation messages) are nested inside
 * their parent's field so the import side has all the rows it needs in
 * a single load.
 *
 * Row shape mirrors the DB columns (snake_case). The serializer
 * (`canonical-json`) handles key sorting; we order rows here by primary key
 * for deterministic output.
 */
export interface SnapshotDump {
  projects: { rows: Row[] }
  workspaces: { rows: Row[] }
  tasks: { rows: Row[]; tags: Row[]; relationships: Row[] }
  conversations: {
    rows: Row[]
    messages: Row[]
    actions: Row[]
    links: Row[]
    participants: Row[]
  }
  inbox: { rows: Row[] }
  sessions: { rows: Row[] }
  knowledge: { rows: Row[] }
}

type Row = Record<string, unknown>

export function dumpProjectsScope(db: Database.Database, projectIds: string[]): SnapshotDump {
  if (projectIds.length === 0) return emptyDump()

  const projects = selectIn(db, 'projects', 'id', projectIds, 'id')
  const workspaces = selectIn(db, 'workspaces', 'project_id', projectIds, 'id')
  const tasks = selectIn(db, 'tasks', 'project_id', projectIds, 'id')
  const inbox = selectIn(db, 'inbox_items', 'project_id', projectIds, 'id')
  const sessions = selectIn(db, 'sessions', 'project_id', projectIds, 'id')
  const knowledge = selectIn(db, 'knowledge_index', 'project_id', projectIds, 'slug')

  const conversations = selectIn(db, 'conversations', 'project_id', projectIds, 'id')
  const convIds = conversations.map((r) => String(r.id))

  const messages = convIds.length > 0 ? selectIn(db, 'conversation_messages', 'conversation_id', convIds, 'id') : []
  const actions = convIds.length > 0 ? selectIn(db, 'conversation_actions', 'conversation_id', convIds, 'id') : []
  const links =
    convIds.length > 0
      ? selectInOrdered(
          db,
          'conversation_links',
          'conversation_id',
          convIds,
          'conversation_id, linked_type, linked_id'
        )
      : []
  const participants =
    convIds.length > 0
      ? selectInOrdered(
          db,
          'conversation_participants',
          'conversation_id',
          convIds,
          'conversation_id, participant_name'
        )
      : []

  // tags + relationships are scoped via item IDs that the project owns.
  // For v1 we collect ids from all project-scoped tables that can carry
  // tags/relationships: tasks, inbox, conversations, sessions, knowledge.
  const itemIds = new Set<string>([
    ...tasks.map((r) => String(r.id)),
    ...inbox.map((r) => String(r.id)),
    ...convIds,
    ...sessions.map((r) => String(r.id)),
    ...knowledge.map((r) => String(r.slug))
  ])

  const tags = itemIds.size > 0 ? selectTagsForItems(db, itemIds) : []
  const relationships = itemIds.size > 0 ? selectRelationshipsForItems(db, itemIds) : []

  return {
    projects: { rows: projects },
    workspaces: { rows: workspaces },
    tasks: { rows: tasks, tags, relationships },
    conversations: { rows: conversations, messages, actions, links, participants },
    inbox: { rows: inbox },
    sessions: { rows: sessions },
    knowledge: { rows: knowledge }
  }
}

function emptyDump(): SnapshotDump {
  return {
    projects: { rows: [] },
    workspaces: { rows: [] },
    tasks: { rows: [], tags: [], relationships: [] },
    conversations: { rows: [], messages: [], actions: [], links: [], participants: [] },
    inbox: { rows: [] },
    sessions: { rows: [] },
    knowledge: { rows: [] }
  }
}

function selectIn(
  db: Database.Database,
  table: string,
  column: string,
  values: string[],
  orderBy: string
): Row[] {
  return selectInOrdered(db, table, column, values, orderBy)
}

function selectInOrdered(
  db: Database.Database,
  table: string,
  column: string,
  values: string[],
  orderBy: string
): Row[] {
  if (values.length === 0) return []
  const placeholders = values.map(() => '?').join(',')
  const sql = `SELECT * FROM ${table} WHERE ${column} IN (${placeholders}) ORDER BY ${orderBy}`
  return db.prepare(sql).all(...values) as Row[]
}

function selectTagsForItems(db: Database.Database, itemIds: Set<string>): Row[] {
  const ids = [...itemIds]
  const placeholders = ids.map(() => '?').join(',')
  const sql = `SELECT * FROM tags WHERE item_id IN (${placeholders}) ORDER BY item_id, tag`
  return db.prepare(sql).all(...ids) as Row[]
}

function selectRelationshipsForItems(db: Database.Database, itemIds: Set<string>): Row[] {
  const ids = [...itemIds]
  const placeholders = ids.map(() => '?').join(',')
  const sql = `SELECT * FROM relationships
               WHERE from_id IN (${placeholders}) OR to_id IN (${placeholders})
               ORDER BY from_id, to_id, type`
  return db.prepare(sql).all(...ids, ...ids) as Row[]
}
