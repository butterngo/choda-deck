import * as fs from 'fs'
import type Database from 'better-sqlite3'
import { classifyCommit, defaultBranchCommits } from './default-branch-log'

// TASK-2312 — `choda-deck session reconcile`: ACTIVE sessions whose task already
// shipped. A session counts as stale when it started more than STALE_DAYS ago and
// a PR merge on its workspace's default branch names its task id (in the squash
// subject or the merge commit's branch name). Read-only: it reports, never closes.

export const STALE_DAYS = 3

export interface StaleSession {
  sessionId: string
  taskId: string
  cwd: string
  startedAt: string
  /** The default-branch commit subject that names the task. */
  mergedBy: string
}

interface ActiveRow {
  id: string
  task_id: string
  started_at: string
  cwd: string | null
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function findStaleSessions(db: Database.Database, now: Date = new Date()): StaleSession[] {
  const cutoff = now.getTime() - STALE_DAYS * 24 * 60 * 60 * 1000
  // A session's own workspace cwd, else its project's.
  const rows = db
    .prepare(
      `SELECT s.id, s.task_id, s.started_at, COALESCE(w.cwd, p.cwd) AS cwd
         FROM sessions s
         LEFT JOIN workspaces w ON w.id = s.workspace_id AND w.project_id = s.project_id
         LEFT JOIN projects p ON p.id = s.project_id
        WHERE s.status = 'active' AND s.task_id IS NOT NULL
        ORDER BY s.started_at`
    )
    .all() as ActiveRow[]

  const subjectsByCwd = new Map<string, string[] | null>()
  const out: StaleSession[] = []
  for (const r of rows) {
    const started = Date.parse(r.started_at)
    if (Number.isNaN(started) || started > cutoff || !r.cwd) continue
    if (!subjectsByCwd.has(r.cwd)) subjectsByCwd.set(r.cwd, mergedSubjects(r.cwd))
    const subjects = subjectsByCwd.get(r.cwd)
    if (!subjects) continue
    // Whole id, either case: `TASK-2312` in a subject, `task-2312-…` in a branch name.
    const id = new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(r.task_id)}(?![0-9])`, 'i')
    const hit = subjects.find((s) => id.test(s))
    if (hit) {
      out.push({
        sessionId: r.id,
        taskId: r.task_id,
        cwd: r.cwd,
        startedAt: r.started_at,
        mergedBy: hit
      })
    }
  }
  return out
}

/** PR-merge subjects on the cwd's default branch; null when the cwd is unreadable. */
function mergedSubjects(cwd: string): string[] | null {
  try {
    if (!fs.statSync(cwd).isDirectory()) return null
    return defaultBranchCommits(cwd)
      .filter((c) => classifyCommit(c) === 'merge')
      .map((c) => c.subject)
  } catch {
    return null
  }
}
