// ADR-030 §Schema additions — single source of truth for which tables carry
// sync metadata and what those columns are. Imported by BOTH the SQLite schema
// (src/core/domain/repositories/schema.ts) and the Postgres migration
// (src/core/domain/repositories/postgres/migrations.ts) so the two backends can
// never drift — the schema-parity test asserts the SQLite DB matches this list,
// and the shared import guarantees Postgres uses the same one.
//
// Phase 1 (TASK-978) is ADDITIVE ONLY: these columns are created with NULL
// defaults and nothing writes Lamport values yet — zero behavior change. The
// Lamport-clock wiring + read-only pull land in Phase 2. The `id → ULID` PK
// swap from ADR-030 is deliberately NOT here (it rewrites every FK target and
// is not auto-safe — separate slice).

// Entity tables that exist on both backends (SQLite + the narrowed Postgres
// surface) and carry a single-column `id`/surrogate identity. Association
// tables (tags, relationships, conversation_participants/links/reads) and
// stdio-only tables (sessions, documents, knowledge_index, …) are intentionally
// excluded — they are not part of the Phase 1 syncable set.
export const SYNCABLE_TABLES: readonly string[] = [
  'projects',
  'workspaces',
  'tasks',
  'inbox_items',
  'conversations',
  'conversation_messages',
  'conversation_actions'
]

// The three sync-metadata columns, per ADR-030:
// - updated_at: Lamport-logical timestamp (monotonic counter), NOT wall-clock.
// - deleted_at: tombstone (NULL = live row), retention via CHODA_TOMBSTONE_TTL_DAYS.
// - origin: device that wrote the row ('laptop' | 'remote'); diagnostic + LWW tie-break.
export interface SyncColumn {
  name: string
  // SQLite type used in the additive ALTER. Postgres uses the mapped type below.
  sqliteType: string
  pgType: string
}

export const SYNC_COLUMNS: readonly SyncColumn[] = [
  { name: 'updated_at', sqliteType: 'INTEGER', pgType: 'BIGINT' },
  { name: 'deleted_at', sqliteType: 'INTEGER', pgType: 'BIGINT' },
  { name: 'origin', sqliteType: 'TEXT', pgType: 'TEXT' }
]
