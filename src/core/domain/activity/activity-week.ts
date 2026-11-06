import * as fs from 'fs'
import * as path from 'path'
import type { ActivityDigest } from './activity-digest'
import { activityDir, addDays } from './activity-runner'

// TASK-3127 — rule 1 of personal-operating-rules: at most 4 owned projects per
// ISO week. The daily digests attribute minutes per workspace path; this folds
// them into choda projects for one ISO week, and owns the week's pick file
// (<artifactsDir>/activity/week-<YYYY-Www>.json) that the gate, the
// SessionStart hook and the Monday digest read.

export const WEEK_PROJECT_LIMIT = 4
export const ACTIVE_MINUTES_THRESHOLD = 60
export const UNREGISTERED_PREFIX = 'unregistered:'

export interface WorkspaceRef {
  projectId: string
  cwd: string
}

export interface WeekProject {
  projectId: string
  minutes: number
  registered: boolean
}

export interface WeekSwap {
  out: string
  in: string
  at: string
  override?: string
}

export interface WeekPick {
  week: string
  picked: string[]
  pickedAt: string
  swaps: WeekSwap[]
}

export interface WeekReport {
  week: string
  limit: number
  active: WeekProject[]
  picked: string[] | null
}

export interface IgnoreOptions {
  homeDir: string
  vaultDir?: string
}

const WEEK_RE = /^(\d{4})-W(\d{2})$/

function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function under(p: string, root: string): boolean {
  return p === root || p.startsWith(root + '/')
}

/** ISO week label `YYYY-Www` of a YYYY-MM-DD date. */
export function isoWeekOf(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1)
  const week = Math.ceil(((t.getTime() - yearStart) / 864e5 + 1) / 7)
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

export function isValidWeek(week: string): boolean {
  const m = WEEK_RE.exec(week)
  if (!m) return false
  const n = Number(m[2])
  return n >= 1 && n <= 53 && isoWeekOf(weekDates(week)[0]) === week
}

/** The seven YYYY-MM-DD dates, Monday first, of an ISO week. */
export function weekDates(week: string): string[] {
  const m = WEEK_RE.exec(week)
  if (!m) throw new Error(`not an ISO week: ${week}`)
  const year = Number(m[1])
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const monday = new Date(jan4)
  monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() || 7) - 1) + (Number(m[2]) - 1) * 7)
  const first = monday.toISOString().slice(0, 10)
  return Array.from({ length: 7 }, (_, i) => addDays(first, i))
}

/** `<repo>.worktrees/<name>/rest` → `<repo>/rest`; any other path unchanged. */
export function foldWorktree(p: string): string {
  return norm(p).replace(/\.worktrees\/[^/]+/, '')
}

/** Directories that are never a project: the dev root, scratch, home, ~/.claude, the vault. */
export function isIgnoredPath(p: string, opts: IgnoreOptions): boolean {
  const c = norm(p)
  const home = norm(opts.homeDir)
  if (c === 'c:/dev' || under(c, 'c:/tmp') || c === home) return true
  if (under(c, `${home}/.claude`)) return true
  return under(c, opts.vaultDir ? norm(opts.vaultDir) : `${home}/vault`)
}

/** The project whose workspace cwd is the longest prefix of `p`, or `unregistered:<p>`. */
export function projectForPath(
  p: string,
  workspaces: WorkspaceRef[]
): { projectId: string; registered: boolean } {
  const c = foldWorktree(p)
  let best: WorkspaceRef | null = null
  let bestLen = -1
  for (const w of workspaces) {
    const n = norm(w.cwd)
    if (under(c, n) && n.length > bestLen) {
      best = w
      bestLen = n.length
    }
  }
  return best
    ? { projectId: best.projectId, registered: true }
    : { projectId: UNREGISTERED_PREFIX + c, registered: false }
}

/** Sum each digest's `byProject` minutes into projects; keep those at or over the threshold. */
export function activeProjects(
  digests: Pick<ActivityDigest, 'metrics'>[],
  workspaces: WorkspaceRef[],
  opts: IgnoreOptions
): WeekProject[] {
  const totals = new Map<string, WeekProject>()
  for (const d of digests) {
    for (const row of d.metrics.byProject ?? []) {
      if (isIgnoredPath(foldWorktree(row.workspace), opts)) continue
      const { projectId, registered } = projectForPath(row.workspace, workspaces)
      const cur = totals.get(projectId) ?? { projectId, minutes: 0, registered }
      cur.minutes += row.activeMinutes
      totals.set(projectId, cur)
    }
  }
  return [...totals.values()]
    .filter((p) => p.minutes >= ACTIVE_MINUTES_THRESHOLD)
    .sort((a, b) => b.minutes - a.minutes || a.projectId.localeCompare(b.projectId))
}

/** The digests on disk for a week's dates; a missing or unreadable day is skipped. */
export function readWeekDigests(artifactsDir: string, week: string): ActivityDigest[] {
  const dir = activityDir(artifactsDir)
  const out: ActivityDigest[] = []
  for (const date of weekDates(week)) {
    const file = path.join(dir, `${date}.json`)
    if (!fs.existsSync(file)) continue
    try {
      out.push(JSON.parse(fs.readFileSync(file, 'utf8')) as ActivityDigest)
    } catch {
      // A half-written digest is not this command's to repair.
    }
  }
  return out
}

export function weekPickFile(artifactsDir: string, week: string): string {
  return path.join(activityDir(artifactsDir), `week-${week}.json`)
}

export function readWeekPick(artifactsDir: string, week: string): WeekPick | null {
  const file = weekPickFile(artifactsDir, week)
  if (!fs.existsSync(file)) return null
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<WeekPick>
  return {
    week,
    picked: raw.picked ?? [],
    pickedAt: raw.pickedAt ?? '',
    swaps: raw.swaps ?? []
  }
}

export function writeWeekPick(artifactsDir: string, pick: WeekPick): string {
  const file = weekPickFile(artifactsDir, pick.week)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(pick, null, 2) + '\n')
  return file
}

/** Why a pick is refused, or null when it is valid. */
export function validatePick(ids: string[], registeredProjects: string[]): string | null {
  if (ids.length === 0) return 'name at least one project to pick'
  if (ids.length > WEEK_PROJECT_LIMIT)
    return `rule 1: at most ${WEEK_PROJECT_LIMIT} projects a week (got ${ids.length})`
  const dup = ids.find((id, i) => ids.indexOf(id) !== i)
  if (dup) return `project "${dup}" is named twice`
  const known = new Set(registeredProjects)
  const unknown = ids.find((id) => !known.has(id))
  return unknown ? `"${unknown}" is not a registered project` : null
}

export function weekReport(
  artifactsDir: string,
  week: string,
  workspaces: WorkspaceRef[],
  opts: IgnoreOptions
): WeekReport {
  return {
    week,
    limit: WEEK_PROJECT_LIMIT,
    active: activeProjects(readWeekDigests(artifactsDir, week), workspaces, opts),
    picked: readWeekPick(artifactsDir, week)?.picked ?? null
  }
}
