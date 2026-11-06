import { spawnSync } from 'child_process'
import type Database from 'better-sqlite3'
import { readWeekPick, writeWeekPick, type WeekPick } from './activity-week'

// TASK-3129 — rules 1 and 2 of personal-operating-rules, as one verdict a gate
// can act on: (1) the project must be one of the week's picked projects; (2) it
// must have no green open PR and no task waiting for Butter's check
// (IMPLEMENTED, any age — Decision 2026-11-06). The swap of a picked slot reads
// the same rule-2 evidence plus READY / IN-PROGRESS work, because a project is
// only "done for the week" when nothing in it is open.

export interface RuleReason {
  rule: 1 | 2
  message: string
  url?: string
}

export interface RulesVerdict {
  projectId: string
  week: string
  verdict: 'pass' | 'blocked'
  reasons: RuleReason[]
  warnings: string[]
}

export interface OpenPr {
  url: string
  statusCheckRollup: { conclusion?: string | null; state?: string | null }[]
}

/** Lists a repo's open PRs. Throws when `gh` is missing or fails in that cwd. */
export type GhRunner = (cwd: string) => OpenPr[]

const PASSING = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])

/** Green = at least one check, and every check concluded passing. Pending or failing is not. */
export function isGreen(pr: OpenPr): boolean {
  const checks = pr.statusCheckRollup ?? []
  return (
    checks.length > 0 &&
    checks.every((c) => PASSING.has(String(c.conclusion ?? c.state ?? '').toUpperCase()))
  )
}

export const defaultGhRunner: GhRunner = (cwd) => {
  const res = spawnSync(
    'gh',
    ['pr', 'list', '--state', 'open', '--json', 'url,statusCheckRollup'],
    {
      cwd,
      encoding: 'utf8'
    }
  )
  if (res.error) throw res.error
  if (res.status !== 0) throw new Error((res.stderr || `gh exited ${res.status}`).trim())
  return JSON.parse(res.stdout || '[]') as OpenPr[]
}

export interface ProjectEvidence {
  implemented: string[]
  open: string[]
  greenPrs: string[]
  warnings: string[]
}

function workspaceCwds(db: Database.Database, projectId: string): string[] {
  const rows = db
    .prepare(
      `SELECT cwd FROM workspaces WHERE project_id = ? AND archived_at IS NULL
       UNION SELECT cwd FROM projects WHERE id = ?`
    )
    .all(projectId, projectId) as { cwd: string }[]
  const seen = new Set<string>()
  return rows
    .map((r) => r.cwd)
    .filter((c) => {
      const k = c.replace(/\\/g, '/').toLowerCase()
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
}

/** What rule 2 and the swap read about a project: its waiting tasks and green PRs. */
export function projectEvidence(
  db: Database.Database,
  projectId: string,
  gh: GhRunner
): ProjectEvidence {
  const tasks = db
    .prepare(
      `SELECT id, status FROM tasks WHERE project_id = ?
       AND status IN ('IMPLEMENTED', 'READY', 'IN-PROGRESS') ORDER BY id`
    )
    .all(projectId) as { id: string; status: string }[]
  const greenPrs: string[] = []
  const warnings: string[] = []
  for (const cwd of workspaceCwds(db, projectId)) {
    try {
      for (const pr of gh(cwd)) if (isGreen(pr) && !greenPrs.includes(pr.url)) greenPrs.push(pr.url)
    } catch (e) {
      warnings.push(`cannot check PRs: ${(e as Error).message} (${cwd})`)
    }
  }
  return {
    implemented: tasks.filter((t) => t.status === 'IMPLEMENTED').map((t) => t.id),
    open: tasks.filter((t) => t.status !== 'IMPLEMENTED').map((t) => t.id),
    greenPrs,
    warnings
  }
}

function listIds(ids: string[]): string {
  const shown = ids.slice(0, 5).join(', ')
  return ids.length > 5 ? `${shown} … (${ids.length} total)` : `${shown} (${ids.length} total)`
}

export function rulesCheck(
  db: Database.Database,
  artifactsDir: string,
  projectId: string,
  week: string,
  gh: GhRunner = defaultGhRunner
): RulesVerdict {
  const reasons: RuleReason[] = []
  const pick = readWeekPick(artifactsDir, week)
  if (!pick) {
    reasons.push({
      rule: 1,
      message: `rule 1: no projects picked for ${week} — run \`choda-deck activity week pick <id>…\``
    })
  } else if (!pick.picked.includes(projectId)) {
    reasons.push({
      rule: 1,
      message: `rule 1: ${projectId} is not one of ${week}'s projects (${pick.picked.join(', ')})`
    })
  }
  const ev = projectEvidence(db, projectId, gh)
  for (const url of ev.greenPrs) {
    reasons.push({ rule: 2, message: `rule 2: green PR waiting to be merged: ${url}`, url })
  }
  if (ev.implemented.length > 0) {
    reasons.push({
      rule: 2,
      message: `rule 2: tasks waiting for your check: ${listIds(ev.implemented)}`
    })
  }
  return {
    projectId,
    week,
    verdict: reasons.length > 0 ? 'blocked' : 'pass',
    reasons,
    warnings: ev.warnings
  }
}

export type SwapResult =
  | { ok: true; pick: WeekPick; file: string }
  | { ok: false; code: 1 | 3; error: string }

/** Swap a picked project's slot. Refused (code 3) while `out` still has open work, unless overridden. */
export function swapWeekSlot(
  db: Database.Database,
  artifactsDir: string,
  week: string,
  out: string,
  into: string,
  opts: { override?: string; gh?: GhRunner; now?: Date } = {}
): SwapResult {
  const pick = readWeekPick(artifactsDir, week)
  if (!pick) return { ok: false, code: 1, error: `no projects picked for ${week}` }
  if (!pick.picked.includes(out)) {
    return { ok: false, code: 1, error: `"${out}" is not one of ${week}'s projects` }
  }
  if (pick.picked.includes(into)) {
    return { ok: false, code: 1, error: `"${into}" is already one of ${week}'s projects` }
  }
  const known = db.prepare('SELECT 1 FROM projects WHERE id = ?').get(into)
  if (!known) return { ok: false, code: 1, error: `"${into}" is not a registered project` }

  if (opts.override === undefined) {
    const ev = projectEvidence(db, out, opts.gh ?? defaultGhRunner)
    const still = [...ev.open, ...ev.implemented, ...ev.greenPrs]
    if (still.length > 0) {
      return {
        ok: false,
        code: 3,
        error: `"${out}" still has open work: ${still.join(', ')} — finish it or pass --override "<reason>"`
      }
    }
  }
  const next: WeekPick = {
    ...pick,
    picked: pick.picked.map((p) => (p === out ? into : p)),
    swaps: [
      ...pick.swaps,
      {
        out,
        in: into,
        at: (opts.now ?? new Date()).toISOString(),
        ...(opts.override !== undefined ? { override: opts.override } : {})
      }
    ]
  }
  return { ok: true, pick: next, file: writeWeekPick(artifactsDir, next) }
}
