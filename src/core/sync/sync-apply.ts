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
  'projects',
  'workspaces',
  'tasks',
  'inbox_items',
  'conversations',
  'conversation_messages',
  'conversation_actions',
  // TASK-2605 — deploy checklist ticks; no FK, so last.
  'deploy_checks'
]

export type ApplyVerdict = 'applied' | 'tombstoned' | 'conflict'

export interface RowVerdict {
  table: string
  id: string
  verdict: ApplyVerdict
  // The Lamport value now standing canonical for this row. On a conflict it is
  // the canonical row's existing value (what beat the push); on apply/tombstone
  // it is the value the row was STORED with (see `stamped`). The pusher logs
  // conflicts against this.
  canonicalLamport: number
  // TASK-3202 — on apply/tombstone, the Lamport the canonical store actually
  // wrote: at least one above everything it already held, so a row pushed by a
  // node whose clock never merged a pull (fresh install, offline at boot) does
  // not land BELOW the cursor every other node already holds — `since` is
  // strictly greater-than, and such a row would never be fetched by anyone.
  // Equals the pushed value when that was already above the canonical clock.
  // Absent on a conflict, and absent from a server older than this field.
  stamped?: number
}

// TASK-3202 — the one place the re-stamp rule lives. `clock` is the canonical
// store's Lamport counter as of this push (advanced row by row inside the
// transaction). An idempotent re-delivery (TASK-1508: same origin, equal value)
// keeps its value — bumping it would make every other node re-fetch a row that
// did not change, and would make the pusher's own next retry read as a conflict.
export function restampLamport(pushed: number, clock: number, redelivery: boolean): number {
  if (redelivery) return pushed
  return Math.max(pushed, clock + 1)
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

/** What the canonical store already holds for a row, when it holds anything. */
export interface CanonicalRowState {
  /** Origin stamped on the canonical row — the device whose write is standing. */
  origin: string | null
  /** Origin of the push being judged. */
  pushOrigin: string
}

// Pure LWW decision for one pushed row against the canonical row's current
// Lamport value (null = the row does not exist canonically yet). Canonical wins
// ties. A winning row with `sync_deleted_at` set is a tombstone, else an upsert.
//
// TASK-1508 AC-5 — the tie is not always a loss. `sync-write-through.ts` enqueues to
// pending_ops in its CATCH block, so a push that SUCCEEDS remotely but whose response is
// lost gets re-pushed at the same Lamport value. Under a bare `<=` the canonical store
// then reports our own already-accepted write back to us as a dropped change, and the
// laptop surfaces "your local change was not applied" about a write that was applied.
//
// Every one of the 53 conflict rows surviving on 2026-08-05 was this case — equality, not
// a strict loss. At-least-once delivery meeting a tie-loses rule.
//
// So: an equal Lamport from the SAME origin that already owns the canonical row is a
// re-delivery, not a conflict. You cannot lose a write to yourself. A differing origin at
// equal Lamport is still a genuine tie and still loses, unchanged.
//
// `canonical` is optional so existing callers keep the old behaviour — a caller that
// cannot cheaply read the origin is no worse off than before.
export function planApplyRow(
  canonicalLamport: number | null,
  row: PulledRow,
  canonical?: CanonicalRowState
): ApplyVerdict {
  if (canonicalLamport !== null && row.sync_updated_at <= canonicalLamport) {
    if (!isRedelivery(canonicalLamport, row, canonical)) return 'conflict'
  }
  return row.sync_deleted_at !== null && row.sync_deleted_at !== undefined
    ? 'tombstoned'
    : 'applied'
}

// The TASK-1508 tie exemption, shared with the re-stamp rule (TASK-3202) so the
// two never disagree about what counts as "our own write coming back".
export function isRedelivery(
  canonicalLamport: number | null,
  row: PulledRow,
  canonical?: CanonicalRowState
): boolean {
  return (
    canonicalLamport !== null &&
    row.sync_updated_at === canonicalLamport &&
    canonical !== undefined &&
    canonical.origin !== null &&
    canonical.origin === canonical.pushOrigin
  )
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
