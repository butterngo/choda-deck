import type Database from 'better-sqlite3'
import { tick } from '../../sync/lamport-clock'

// TASK-2605 — one row per (goal, environment, checklist item) that someone
// ticked. Butter, 2026-10-21: ticks live in the choda DB per environment, shared
// by the companion and /ichiba-deploy, and sync like the other synced tables.
//
// The sync engine keys every table on a single text `id` (sync-pull, sync-sink,
// write-through, pending_ops), so the natural key (goal, env, item) is folded
// into a synthetic id and kept UNIQUE. An un-tick is a soft delete: the row
// stays with `sync_deleted_at` set, so the change syncs as a tombstone.

export type DeployEnv = 'qc' | 'prod'
export const DEPLOY_ENVS: readonly DeployEnv[] = ['qc', 'prod']

export interface SetDeployCheckInput {
  goalTaskId: string
  env: DeployEnv
  itemKey: string
  done: boolean
  doneBy: string
  note?: string | null
}

export interface DeployCheckRow {
  id: string
  goalTaskId: string
  env: DeployEnv
  itemKey: string
  doneBy: string
  doneAt: string
  note: string | null
  deleted: boolean
}

export interface DeployCheckEntry {
  doneBy: string
  doneAt: string
  note: string | null
}

export type DeployChecks = Record<DeployEnv, Record<string, DeployCheckEntry>>

export const deployCheckId = (goalTaskId: string, env: DeployEnv, itemKey: string): string =>
  `${goalTaskId}:${env}:${itemKey}`

function toRow(r: Record<string, unknown>): DeployCheckRow {
  return {
    id: r.id as string,
    goalTaskId: r.goal_task_id as string,
    env: r.env as DeployEnv,
    itemKey: r.item_key as string,
    doneBy: r.done_by as string,
    doneAt: r.done_at as string,
    note: (r.note as string | null) ?? null,
    deleted: r.sync_deleted_at !== null && r.sync_deleted_at !== undefined
  }
}

export class DeployCheckRepository {
  constructor(private readonly db: Database.Database) {}

  /** Returns the row as stored; `id` lets the sync write-through push it. */
  set(input: SetDeployCheckInput): DeployCheckRow {
    const id = deployCheckId(input.goalTaskId, input.env, input.itemKey)
    const lamport = tick(this.db)
    if (input.done) {
      this.db
        .prepare(
          `INSERT INTO deploy_checks (id, goal_task_id, env, item_key, done_by, done_at, note, sync_updated_at, sync_deleted_at, sync_origin)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'remote')
           ON CONFLICT(id) DO UPDATE SET done_by = excluded.done_by, done_at = excluded.done_at,
             note = excluded.note, sync_updated_at = excluded.sync_updated_at, sync_deleted_at = NULL`
        )
        .run(id, input.goalTaskId, input.env, input.itemKey, input.doneBy, new Date().toISOString(), input.note ?? null, lamport)
    } else {
      this.db
        .prepare(`UPDATE deploy_checks SET sync_deleted_at = ?, sync_updated_at = ? WHERE id = ?`)
        .run(lamport, lamport, id)
    }
    const row = this.db.prepare(`SELECT * FROM deploy_checks WHERE id = ?`).get(id) as Record<string, unknown> | undefined
    return row
      ? toRow(row)
      : { id, goalTaskId: input.goalTaskId, env: input.env, itemKey: input.itemKey, doneBy: input.doneBy, doneAt: '', note: null, deleted: true }
  }

  /** Live ticks only, keyed by env then item key. */
  list(goalTaskId: string): DeployChecks {
    const out: DeployChecks = { qc: {}, prod: {} }
    const rows = this.db
      .prepare(`SELECT * FROM deploy_checks WHERE goal_task_id = ? AND sync_deleted_at IS NULL ORDER BY item_key`)
      .all(goalTaskId) as Record<string, unknown>[]
    for (const r of rows.map(toRow)) out[r.env][r.itemKey] = { doneBy: r.doneBy, doneAt: r.doneAt, note: r.note }
    return out
  }
}
