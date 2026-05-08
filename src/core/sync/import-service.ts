import * as fs from 'fs'
import * as path from 'path'
import type Database from 'better-sqlite3'

import { runPreflight, type PreflightReport, type PreflightOptions } from './preflight'
import { createNamedBackup } from '../backup-service'
import { SNAPSHOT_FILES } from './snapshot-types'
import type { PathsMapping } from './paths-mapping'

type Row = Record<string, unknown>

interface IncomingDomain {
  projects: { rows: Row[] }
  workspaces: { rows: Row[] }
  tasks: { rows: Row[]; tags?: Row[]; relationships?: Row[] }
  conversations: {
    rows: Row[]
    messages?: Row[]
    actions?: Row[]
    links?: Row[]
    participants?: Row[]
  }
  inbox: { rows: Row[] }
  sessions: { rows: Row[] }
  knowledge: { rows: Row[] }
}

export interface ImportOptions {
  snapshotDir: string
  db: Database.Database
  pathsMapping: PathsMapping
  /** Required when actually writing — used by the pre-import backup helper. */
  dataDir: string
  /** CI mode: missing path mappings = error, no interactive prompt. */
  yes?: boolean
  /** Run preflight + summarize, exit before backup, txn, or any write. */
  dryRun?: boolean
  /** Inject a clock for deterministic backup names in tests. */
  now?: () => Date
}

export interface ImportResult {
  status: 'imported' | 'dry-run'
  preflight: PreflightReport
  backupPath: string | null
  rowCounts: { table: string; deleted: number; inserted: number }[]
}

export function runImport(opts: ImportOptions): ImportResult {
  if (opts.dryRun && opts.yes) {
    throw new Error('runImport: --dry-run and --yes are mutually exclusive')
  }

  const preflight = runPreflight({
    snapshotDir: opts.snapshotDir,
    db: opts.db,
    pathsMapping: opts.pathsMapping,
    yes: opts.yes ?? false
  } satisfies PreflightOptions)

  if (!preflight.ok) {
    throw new Error(
      `import preflight failed:\n${preflight.errors.map((e) => `  - ${e}`).join('\n')}`
    )
  }
  if (!preflight.manifest) {
    throw new Error('runImport: preflight succeeded but produced no manifest — invariant broken')
  }

  if (opts.dryRun) {
    return {
      status: 'dry-run',
      preflight,
      backupPath: null,
      rowCounts: []
    }
  }

  const incoming = loadDomainFiles(opts.snapshotDir)
  const projectIds = preflight.manifest.projectIds

  // Step 1: pre-import backup (outside the transaction so it survives a rollback).
  // Use sync `serialize()` instead of async `backup()` so the file is on disk
  // before the txn opens — better-sqlite3's `backup()` returns a Promise that
  // outlives the surrounding sync code and races against subsequent reads.
  const backupName = formatBackupName(opts.now ? opts.now() : new Date())
  const backupPath = createNamedBackup(
    { backup: (target) => fs.writeFileSync(target, opts.db.serialize()) },
    opts.dataDir,
    backupName
  )

  // Step 2: atomic apply via SQL transaction. better-sqlite3 wraps the body
  // in BEGIN/COMMIT and rolls back automatically on throw.
  const rowCounts: { table: string; deleted: number; inserted: number }[] = []
  const apply = opts.db.transaction(() => {
    for (const projectId of projectIds) {
      const counts = applyProjectSnapshot(opts.db, projectId, incoming)
      rowCounts.push(...counts)
    }
  })
  apply()

  return { status: 'imported', preflight, backupPath, rowCounts }
}

function loadDomainFiles(snapshotDir: string): IncomingDomain {
  const read = <T>(name: string): T => {
    const raw = fs.readFileSync(path.join(snapshotDir, name), 'utf8')
    return JSON.parse(raw) as T
  }
  for (const f of SNAPSHOT_FILES) {
    if (!fs.existsSync(path.join(snapshotDir, f))) {
      throw new Error(`runImport: missing ${f} (preflight should have caught this)`)
    }
  }
  return {
    projects: read('projects.json'),
    workspaces: read('workspaces.json'),
    tasks: read('tasks.json'),
    conversations: read('conversations.json'),
    inbox: read('inbox.json'),
    sessions: read('sessions.json'),
    knowledge: read('knowledge.json')
  }
}

function formatBackupName(d: Date): string {
  // Stable filename-safe ISO: 2026-05-08T12-34-56-789Z
  return `pre-import-${d.toISOString().replace(/[:.]/g, '-')}`
}

interface RowCount {
  table: string
  deleted: number
  inserted: number
}

function applyProjectSnapshot(
  db: Database.Database,
  projectId: string,
  incoming: IncomingDomain
): RowCount[] {
  const counts: RowCount[] = []

  const incomingProjectRow = incoming.projects.rows.find((r) => r.id === projectId)
  const incomingWorkspaces = incoming.workspaces.rows.filter((r) => r.project_id === projectId)
  const incomingTasks = incoming.tasks.rows.filter((r) => r.project_id === projectId)
  const incomingInbox = incoming.inbox.rows.filter((r) => r.project_id === projectId)
  const incomingSessions = incoming.sessions.rows.filter((r) => r.project_id === projectId)
  const incomingKnowledge = incoming.knowledge.rows.filter((r) => r.project_id === projectId)
  const incomingConversations = incoming.conversations.rows.filter(
    (r) => r.project_id === projectId
  )
  const convIds = new Set(incomingConversations.map((r) => String(r.id)))
  const incomingMessages = (incoming.conversations.messages ?? []).filter((r) =>
    convIds.has(String(r.conversation_id))
  )
  const incomingActions = (incoming.conversations.actions ?? []).filter((r) =>
    convIds.has(String(r.conversation_id))
  )
  const incomingLinks = (incoming.conversations.links ?? []).filter((r) =>
    convIds.has(String(r.conversation_id))
  )
  const incomingParticipants = (incoming.conversations.participants ?? []).filter((r) =>
    convIds.has(String(r.conversation_id))
  )

  const projectItemIds = new Set<string>([
    ...incomingTasks.map((r) => String(r.id)),
    ...incomingInbox.map((r) => String(r.id)),
    ...incomingSessions.map((r) => String(r.id)),
    ...incomingKnowledge.map((r) => String(r.slug)),
    ...incomingConversations.map((r) => String(r.id))
  ])
  const incomingTags = (incoming.tasks.tags ?? []).filter((r) =>
    projectItemIds.has(String(r.item_id))
  )
  const incomingRelationships = (incoming.tasks.relationships ?? []).filter(
    (r) => projectItemIds.has(String(r.from_id)) && projectItemIds.has(String(r.to_id))
  )

  // ── DELETE child-first per FK order ─────────────────────────────────────
  const liveTaskIds = selectIdsFor(db, 'tasks', 'project_id', projectId, 'id')
  const liveInboxIds = selectIdsFor(db, 'inbox_items', 'project_id', projectId, 'id')
  const liveSessionIds = selectIdsFor(db, 'sessions', 'project_id', projectId, 'id')
  const liveKnowledgeIds = selectIdsFor(db, 'knowledge_index', 'project_id', projectId, 'slug')
  const liveConvIds = selectIdsFor(db, 'conversations', 'project_id', projectId, 'id')
  const liveItemIds = [
    ...liveTaskIds,
    ...liveInboxIds,
    ...liveSessionIds,
    ...liveKnowledgeIds,
    ...liveConvIds
  ]

  counts.push({
    table: 'conversation_messages',
    deleted: deleteByIn(db, 'conversation_messages', 'conversation_id', liveConvIds),
    inserted: 0
  })
  counts.push({
    table: 'conversation_links',
    deleted: deleteByIn(db, 'conversation_links', 'conversation_id', liveConvIds),
    inserted: 0
  })
  counts.push({
    table: 'conversation_actions',
    deleted: deleteByIn(db, 'conversation_actions', 'conversation_id', liveConvIds),
    inserted: 0
  })
  counts.push({
    table: 'conversation_participants',
    deleted: deleteByIn(db, 'conversation_participants', 'conversation_id', liveConvIds),
    inserted: 0
  })
  counts.push({
    table: 'conversations',
    deleted: deleteByEqual(db, 'conversations', 'project_id', projectId),
    inserted: 0
  })
  counts.push({
    table: 'tags',
    deleted: deleteByIn(db, 'tags', 'item_id', liveItemIds),
    inserted: 0
  })
  counts.push({
    table: 'relationships',
    deleted: deleteRelationshipsForItems(db, liveItemIds),
    inserted: 0
  })
  counts.push({
    table: 'inbox_items',
    deleted: deleteByEqual(db, 'inbox_items', 'project_id', projectId),
    inserted: 0
  })
  counts.push({
    table: 'sessions',
    deleted: deleteByEqual(db, 'sessions', 'project_id', projectId),
    inserted: 0
  })
  counts.push({
    table: 'knowledge_index',
    deleted: deleteByEqual(db, 'knowledge_index', 'project_id', projectId),
    inserted: 0
  })
  counts.push({
    table: 'tasks',
    deleted: deleteByEqual(db, 'tasks', 'project_id', projectId),
    inserted: 0
  })
  counts.push({
    table: 'workspaces',
    deleted: deleteByEqual(db, 'workspaces', 'project_id', projectId),
    inserted: 0
  })
  counts.push({
    table: 'projects',
    deleted: deleteByEqual(db, 'projects', 'id', projectId),
    inserted: 0
  })

  // ── INSERT parent-first ─────────────────────────────────────────────────
  if (incomingProjectRow) bumpInserted(counts, 'projects', insertRows(db, 'projects', [incomingProjectRow]))
  bumpInserted(counts, 'workspaces', insertRows(db, 'workspaces', incomingWorkspaces))
  bumpInserted(counts, 'tasks', insertRows(db, 'tasks', incomingTasks))
  bumpInserted(counts, 'inbox_items', insertRows(db, 'inbox_items', incomingInbox))
  bumpInserted(counts, 'sessions', insertRows(db, 'sessions', incomingSessions))
  bumpInserted(counts, 'knowledge_index', insertRows(db, 'knowledge_index', incomingKnowledge))
  bumpInserted(counts, 'conversations', insertRows(db, 'conversations', incomingConversations))
  bumpInserted(
    counts,
    'conversation_participants',
    insertRows(db, 'conversation_participants', incomingParticipants)
  )
  bumpInserted(
    counts,
    'conversation_messages',
    insertRows(db, 'conversation_messages', incomingMessages)
  )
  bumpInserted(
    counts,
    'conversation_actions',
    insertRows(db, 'conversation_actions', incomingActions)
  )
  bumpInserted(counts, 'conversation_links', insertRows(db, 'conversation_links', incomingLinks))
  bumpInserted(counts, 'tags', insertRows(db, 'tags', incomingTags))
  bumpInserted(counts, 'relationships', insertRows(db, 'relationships', incomingRelationships))

  return counts
}

function bumpInserted(counts: RowCount[], table: string, n: number): void {
  const found = counts.find((c) => c.table === table)
  if (found) found.inserted += n
  else counts.push({ table, deleted: 0, inserted: n })
}

function selectIdsFor(
  db: Database.Database,
  table: string,
  column: string,
  value: string,
  idColumn: string
): string[] {
  const rows = db
    .prepare(`SELECT ${idColumn} AS id FROM ${table} WHERE ${column} = ?`)
    .all(value) as Array<{ id: string }>
  return rows.map((r) => r.id)
}

function deleteByEqual(
  db: Database.Database,
  table: string,
  column: string,
  value: string
): number {
  const info = db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(value)
  return Number(info.changes)
}

function deleteByIn(db: Database.Database, table: string, column: string, ids: string[]): number {
  if (ids.length === 0) return 0
  const placeholders = ids.map(() => '?').join(',')
  const info = db
    .prepare(`DELETE FROM ${table} WHERE ${column} IN (${placeholders})`)
    .run(...ids)
  return Number(info.changes)
}

function deleteRelationshipsForItems(db: Database.Database, itemIds: string[]): number {
  if (itemIds.length === 0) return 0
  const placeholders = itemIds.map(() => '?').join(',')
  const info = db
    .prepare(
      `DELETE FROM relationships
       WHERE from_id IN (${placeholders}) OR to_id IN (${placeholders})`
    )
    .run(...itemIds, ...itemIds)
  return Number(info.changes)
}

function insertRows(db: Database.Database, table: string, rows: Row[]): number {
  if (rows.length === 0) return 0
  // Intersect row keys with the target table's actual columns. This makes
  // import resilient to schema drift in either direction:
  //   - Source DB has a legacy column the target schema dropped → silently
  //     ignore it (data loss is acceptable; column no longer exists).
  //   - Source DB lacks a column the target schema added → target uses the
  //     column's default (NULL or DEFAULT clause).
  const targetCols = new Set(tableColumns(db, table))
  const allKeys = new Set<string>()
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (targetCols.has(k)) allKeys.add(k)
    }
  }
  const cols = [...allKeys].sort()
  if (cols.length === 0) return 0
  const placeholders = cols.map(() => '?').join(',')
  const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`
  const stmt = db.prepare(sql)
  let inserted = 0
  for (const row of rows) {
    const values = cols.map((c) => normalizeValue(row[c]))
    stmt.run(...values)
    inserted++
  }
  return inserted
}

const tableColumnCache = new WeakMap<Database.Database, Map<string, string[]>>()

function tableColumns(db: Database.Database, table: string): string[] {
  let perDb = tableColumnCache.get(db)
  if (!perDb) {
    perDb = new Map<string, string[]>()
    tableColumnCache.set(db, perDb)
  }
  const cached = perDb.get(table)
  if (cached) return cached
  const cols = (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name)
  perDb.set(table, cols)
  return cols
}

function normalizeValue(v: unknown): string | number | bigint | Buffer | null {
  if (v === undefined || v === null) return null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') return v
  if (Buffer.isBuffer(v)) return v
  // Defensive: anything else (objects/arrays) gets serialized — should not
  // happen for canonical-json-derived snapshots, but covers schema drift.
  return JSON.stringify(v)
}
