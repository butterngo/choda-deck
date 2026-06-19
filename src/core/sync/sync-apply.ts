// ADR-030 Phase 3 (TASK-1063 / 979a) — the WRITE side of sync, symmetric to the
// read side (sync-pull.ts / GET /sync/since). The laptop pushes its locally
// stamped deltas to the canonical store, which applies them under server-side
// LWW and returns a per-row verdict so the pusher knows which ops were dropped.
//
// Designed as a dedicated endpoint (POST /sync/apply), NOT an MCP tool: the
// claude.ai connector's tool surface stays read + capture only (ADR-026
// §Per-tool scoping). The HTTP route is auth-gated identically to /sync/since.
//
// Conflict rule (ADR-030 §Conflict rule, the write side): the canonical store
// wins ties — a pushed row applies only if its Lamport `sync_updated_at` is
// strictly greater than the canonical row's. This mirrors sync-pull's
// `local >= remote → skip` from the other direction: there the local copy is
// authoritative on ties; here the canonical (Postgres-when-reachable) is.

import type { PulledRow, TableDelta } from './sync-pull'

// Write-through apply scope. tasks + inbox (979a/979b) plus conversations
// (TASK-1136). The earlier decisionSummary-drop risk is gone: conversations are
// an append-only log (TASK-1067) — decision/signoff are messages, the header is
// a fold recomputed on each node after apply, so a generic LWW upsert on the
// header columns is harmless. Both `conversations` (skeleton + derived cache)
// and `conversation_messages` (the authoritative log) sync; the apply path
// recomputes the header after applying message rows. The set matches the pull
// side (SYNCABLE_TABLES) for the conversation tables so both directions agree.
export const APPLY_TABLES: readonly string[] = [
  'tasks',
  'inbox_items',
  'conversations',
  'conversation_messages',
  'conversation_actions'
]

export type ApplyVerdict = 'applied' | 'tombstoned' | 'conflict'

export interface RowVerdict {
  table: string
  id: string
  verdict: ApplyVerdict
  // The Lamport value now standing canonical for this row. On a conflict it is
  // the canonical row's existing value (what beat the push); on apply/tombstone
  // it is the pushed row's value. The pusher logs conflicts against this.
  canonicalLamport: number
}

export interface ApplyResult {
  applied: number
  tombstoned: number
  conflicts: number
  verdicts: RowVerdict[]
}

// The canonical store applies pushed deltas. Symmetric to PullSource
// (sync-pull.ts) — implemented by PostgresTaskService; the HTTP transport
// injects it to back POST /sync/apply.
export interface ApplySink {
  applyDelta(deltas: TableDelta[], origin: string): Promise<ApplyResult>
}

// Pure LWW decision for one pushed row against the canonical row's current
// Lamport value (null = the row does not exist canonically yet). Canonical wins
// ties. A winning row with `sync_deleted_at` set is a tombstone, else an upsert.
export function planApplyRow(canonicalLamport: number | null, row: PulledRow): ApplyVerdict {
  if (canonicalLamport !== null && row.sync_updated_at <= canonicalLamport) {
    return 'conflict'
  }
  return row.sync_deleted_at !== null && row.sync_deleted_at !== undefined
    ? 'tombstoned'
    : 'applied'
}

// Guard for the endpoint: reject a delta set that names any non-APPLY table
// before touching the DB, so an unknown/SQL-unsafe identifier never reaches a
// query and a conversation push can't slip through the tasks+inbox path.
export function assertApplyTables(deltas: TableDelta[]): void {
  for (const delta of deltas) {
    if (!APPLY_TABLES.includes(delta.table)) {
      throw new Error(`sync apply: table not in apply scope: ${delta.table}`)
    }
  }
}
