import * as fs from 'fs'
import * as path from 'path'
import { execFileSync } from 'child_process'
import type Database from 'better-sqlite3'
import { splitLines } from '../../utils/lines'
import {
  computeTranscriptDigest,
  localDate,
  DEFAULT_TZ,
  type ActivityDigest
} from './activity-digest'

// TASK-2151 — the I/O half of the daily activity digest. Gathers the inputs the
// pure engine (activity-digest.ts) cannot touch — transcript files, history.jsonl,
// the choda DB, git — and owns the on-disk store at <artifactsDir>/activity/,
// mirroring the meetings file store (companion/meetings.ts): one JSON per local
// date, no schema, no sync.

export const RETENTION_DAYS = 90
export const CATCH_UP_DAYS = 7

export interface ActivityRunnerOptions {
  artifactsDir: string
  /** Opened by the adapter (core never opens one); null when no DB exists yet. */
  db: Database.Database | null
  /** Home dir holding `.claude/` — injected so tests never read the real one. */
  homeDir: string
  tz?: string
  now?: Date
}

export interface ActivityRunResult {
  written: { date: string; file: string; prompts: number }[]
  kept: string[]
  pruned: string[]
}

export function activityDir(artifactsDir: string): string {
  return path.join(artifactsDir, 'activity')
}

/** YYYY-MM-DD shifted by whole days (calendar arithmetic, tz-free). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

/** The UTC instant of local midnight at the start of `date` in `tz`. */
export function localMidnightUtc(date: string, tz: string): number {
  const [y, m, d] = date.split('-').map(Number)
  const guess = Date.UTC(y, m - 1, d)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).formatToParts(guess)
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value)
  const asLocal = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'))
  return guess - (asLocal - guess)
}

function walkJsonl(dir: string, minMtimeMs: number, out: string[]): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walkJsonl(p, minMtimeMs, out)
    else if (e.name.endsWith('.jsonl') && fs.statSync(p).mtimeMs >= minMtimeMs) out.push(p)
  }
}

function countHistoryRows(homeDir: string, date: string, tz: string): number {
  let content: string
  try {
    content = fs.readFileSync(path.join(homeDir, '.claude', 'history.jsonl'), 'utf8')
  } catch {
    return 0
  }
  let n = 0
  for (const line of splitLines(content)) {
    if (!line.trim()) continue
    try {
      const ts = (JSON.parse(line) as { timestamp?: unknown }).timestamp
      if (typeof ts === 'number' && localDate(ts, tz) === date) n++
    } catch {
      /* malformed history line — not ours to report */
    }
  }
  return n
}

interface DbInputs {
  cwds: string[]
  sessionEndings: string[]
}

function readDb(db: Database.Database | null): DbInputs {
  if (!db) return { cwds: [], sessionEndings: [] }
  const cwds = db.prepare('SELECT cwd FROM workspaces UNION SELECT cwd FROM projects').all() as {
    cwd: string
  }[]
  const ended = db
    .prepare("SELECT ended_at FROM sessions WHERE status = 'completed' AND ended_at IS NOT NULL")
    .all() as { ended_at: string }[]
  return { cwds: cwds.map((r) => r.cwd), sessionEndings: ended.map((r) => r.ended_at) }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
    timeout: 15_000
  }).trim()
}

/**
 * First-parent commits on each registered repo's default branch inside the local
 * day. Several workspaces can share one repo, so repos are deduped by their git
 * common dir. A missing or non-git cwd is skipped and counted.
 */
export function countMergesToDefault(
  cwds: string[],
  date: string,
  tz: string
): { merges: number; skipped: number } {
  const since = new Date(localMidnightUtc(date, tz)).toISOString()
  const until = new Date(localMidnightUtc(addDays(date, 1), tz)).toISOString()
  const seen = new Set<string>()
  let merges = 0
  let skipped = 0
  for (const cwd of cwds) {
    let common: string
    try {
      if (!fs.statSync(cwd).isDirectory()) throw new Error('not a dir')
      common = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']).toLowerCase()
    } catch {
      skipped++
      continue
    }
    if (seen.has(common)) continue
    seen.add(common)
    let ref = 'origin/main'
    try {
      ref = git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
    } catch {
      /* no origin/HEAD — fall back to origin/main */
    }
    try {
      const out = git(cwd, [
        'log',
        ref,
        '--first-parent',
        `--since=${since}`,
        `--until=${until}`,
        '--format=%H'
      ])
      merges += out ? out.split(/\r?\n/).length : 0
    } catch {
      skipped++
    }
  }
  return { merges, skipped }
}

/** Build one date's digest from the live sources. */
export function buildDigest(date: string, opts: ActivityRunnerOptions): ActivityDigest {
  const tz = opts.tz ?? DEFAULT_TZ
  const files: string[] = []
  walkJsonl(path.join(opts.homeDir, '.claude', 'projects'), localMidnightUtc(date, tz), files)
  const { cwds, sessionEndings } = readDb(opts.db)
  const transcript = computeTranscriptDigest({
    date,
    tz,
    files: files.map((f) => fs.readFileSync(f, 'utf8')),
    workspaces: cwds
  })
  const { merges, skipped } = countMergesToDefault(cwds, date, tz)
  const sessionsCompleted = sessionEndings.filter((e) => {
    const t = Date.parse(e)
    return !Number.isNaN(t) && localDate(t, tz) === date
  }).length

  return {
    date,
    tz,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    claudeCodeVersions: transcript.claudeCodeVersions,
    sources: {
      ...transcript.sources,
      historyRows: countHistoryRows(opts.homeDir, date, tz),
      skippedRepos: skipped
    },
    metrics: { ...transcript.metrics, sessionsCompleted, mergesToDefault: merges }
  }
}

function writeDigest(dir: string, digest: ActivityDigest): string {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${digest.date}.json`)
  fs.writeFileSync(file, JSON.stringify(digest, null, 2) + '\n')
  return file
}

/** Delete digest files whose filename date is older than RETENTION_DAYS. */
export function pruneDigests(dir: string, today: string): string[] {
  const cutoff = addDays(today, -RETENTION_DAYS)
  const pruned: string[] = []
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return pruned
  }
  for (const name of names) {
    const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(name)
    if (m && m[1] < cutoff) {
      fs.rmSync(path.join(dir, name))
      pruned.push(name)
    }
  }
  return pruned
}

export interface RunRequest {
  /** Explicit date; defaults to yesterday in tz. Ignored when catchUp is set. */
  date?: string
  /** Fill every missing date in the last CATCH_UP_DAYS (excluding today); never rewrite. */
  catchUp?: boolean
}

export function runActivityDigest(req: RunRequest, opts: ActivityRunnerOptions): ActivityRunResult {
  const tz = opts.tz ?? DEFAULT_TZ
  const today = localDate((opts.now ?? new Date()).getTime(), tz)
  const dir = activityDir(opts.artifactsDir)
  const result: ActivityRunResult = { written: [], kept: [], pruned: [] }

  const dates = req.catchUp
    ? Array.from({ length: CATCH_UP_DAYS }, (_, i) => addDays(today, -(CATCH_UP_DAYS - i)))
    : [req.date ?? addDays(today, -1)]

  for (const date of dates) {
    if (req.catchUp && fs.existsSync(path.join(dir, `${date}.json`))) {
      result.kept.push(date)
      continue
    }
    const digest = buildDigest(date, opts)
    const file = writeDigest(dir, digest)
    result.written.push({ date, file, prompts: digest.metrics.prompts })
  }
  result.pruned = pruneDigests(dir, today)
  return result
}
