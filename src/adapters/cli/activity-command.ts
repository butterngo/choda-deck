import * as fs from 'fs'
import * as os from 'os'

// TASK-2151 — `choda-deck activity digest`. Thin adapter: parse flags, resolve
// the data dir (CHODA_DATA_DIR-aware), open the DB read-only when it exists, and
// hand everything to the core runner. Exit 2 on usage errors, like `mcp`/`sync`.

export const ACTIVITY_HELP = `activity digest [--date YYYY-MM-DD] [--catch-up] [--tz <IANA zone>]
  Write the daily Claude activity digest to <data>/artifacts/activity/<date>.json.
  --date      Local date to digest (default: yesterday)
  --catch-up  Fill every missing date in the last 7 days; never rewrites a file
  --tz        Time zone for day boundaries (default: Asia/Ho_Chi_Minh)
activity week [--week YYYY-Www] [--json]
  Choda projects with >= 60 active minutes in an ISO week, and the week's pick.
activity week pick <projectId>... [--week YYYY-Www]
  Record the week's owned projects (at most 4 — rule 1 of personal-operating-rules).
activity week swap <out> <in> [--override "<reason>"] [--week YYYY-Www]
  Hand a picked project's slot to another. Refused (exit 3) while <out> still has
  READY / IN-PROGRESS / IMPLEMENTED tasks or a green open PR, unless overridden.
`

interface ParsedArgs {
  date?: string
  catchUp: boolean
  tz?: string
}

function parseArgs(args: string[]): ParsedArgs | string {
  const out: ParsedArgs = { catchUp: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--catch-up') out.catchUp = true
    else if (a === '--date' || a === '--tz') {
      const v = args[++i]
      if (!v) return `${a} needs a value`
      if (a === '--date') out.date = v
      else out.tz = v
    } else return `unknown option "${a}"`
  }
  if (out.date !== undefined) {
    const valid =
      /^\d{4}-\d{2}-\d{2}$/.test(out.date) &&
      new Date(`${out.date}T00:00:00Z`).toISOString().startsWith(out.date)
    if (!valid) return `--date must be a real YYYY-MM-DD date (got "${out.date}")`
  }
  if (out.tz !== undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: out.tz })
    } catch {
      return `--tz is not a known time zone (got "${out.tz}")`
    }
  }
  return out
}

interface WeekArgs {
  pick: string[] | null
  swap: string[] | null
  override?: string
  week?: string
  json: boolean
}

function parseWeekArgs(args: string[]): WeekArgs | string {
  const out: WeekArgs = { pick: null, swap: null, json: false }
  let i = 0
  if (args[0] === 'pick') {
    out.pick = []
    i = 1
  } else if (args[0] === 'swap') {
    out.swap = []
    i = 1
  }
  for (; i < args.length; i++) {
    const a = args[i]
    if (a === '--json') out.json = true
    else if (a === '--week' || a === '--override') {
      const v = args[++i]
      if (!v) return `${a} needs a value`
      if (a === '--week') out.week = v
      else out.override = v
    } else if (a.startsWith('--')) return `unknown option "${a}"`
    else if (out.pick) out.pick.push(a)
    else if (out.swap) out.swap.push(a)
    else return `unexpected argument "${a}"`
  }
  if (out.swap && out.swap.length !== 2) return 'swap takes exactly <out> <in>'
  if (out.override !== undefined && !out.swap) return '--override only applies to swap'
  return out
}

// TASK-3127 — rule 1 of personal-operating-rules: report the week's active
// projects, or record the week's pick. A refused pick exits 1 and writes nothing.
async function runWeek(args: string[]): Promise<number> {
  const parsed = parseWeekArgs(args)
  if (typeof parsed === 'string') {
    process.stderr.write(`error: ${parsed}\n\n${ACTIVITY_HELP}`)
    return 2
  }
  const week = await import('../../core/domain/activity/activity-week')
  const { localDate, DEFAULT_TZ } = await import('../../core/domain/activity/activity-digest')
  const label = parsed.week ?? week.isoWeekOf(localDate(Date.now(), DEFAULT_TZ))
  if (!week.isValidWeek(label)) {
    process.stderr.write(`error: --week must be an ISO week like 2026-W45 (got "${label}")\n`)
    return 2
  }

  const { resolveDataPaths } = await import('../../core/paths')
  const { default: Database } = await import('better-sqlite3')
  const { dbPath, artifactsDir } = resolveDataPaths()
  const db = fs.existsSync(dbPath)
    ? new Database(dbPath, { readonly: true, fileMustExist: true })
    : null
  try {
    const workspaces = (db
      ?.prepare(
        `SELECT project_id AS projectId, cwd FROM workspaces WHERE archived_at IS NULL
       UNION ALL SELECT id AS projectId, cwd FROM projects`
      )
      .all() ?? []) as { projectId: string; cwd: string }[]

    // TASK-3129 — a picked project with nothing left open hands its slot to another.
    if (parsed.swap) {
      if (!db) {
        process.stderr.write(`error: no choda database at ${dbPath}\n`)
        return 1
      }
      const { swapWeekSlot } = await import('../../core/domain/activity/rules-check')
      const [out, into] = parsed.swap
      const res = swapWeekSlot(db, artifactsDir, label, out, into, { override: parsed.override })
      if (!res.ok) {
        process.stderr.write(`error: ${res.error}\n`)
        return res.code
      }
      process.stdout.write(
        `activity week ${label}: ${out} -> ${into}, picked ${res.pick.picked.join(', ')}\n`
      )
      return 0
    }

    if (parsed.pick) {
      const projects = (db?.prepare('SELECT id FROM projects').all() ?? []) as { id: string }[]
      const refused = week.validatePick(
        parsed.pick,
        projects.map((p) => p.id)
      )
      if (refused) {
        process.stderr.write(`error: ${refused}\n`)
        return 1
      }
      const prev = week.readWeekPick(artifactsDir, label)
      const file = week.writeWeekPick(artifactsDir, {
        week: label,
        picked: parsed.pick,
        pickedAt: new Date().toISOString(),
        swaps: prev?.swaps ?? []
      })
      process.stdout.write(`activity week ${label}: picked ${parsed.pick.join(', ')} -> ${file}\n`)
      return 0
    }

    const report = week.weekReport(artifactsDir, label, workspaces, {
      homeDir: os.homedir(),
      vaultDir: process.env.CHODA_CONTENT_ROOT || undefined
    })
    if (parsed.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n')
      return 0
    }
    process.stdout.write(
      `activity week ${label}: ${report.active.length} active projects (limit ${report.limit})\n`
    )
    for (const p of report.active) {
      process.stdout.write(
        `  ${p.projectId}  ${p.minutes} min${p.registered ? '' : ' (unregistered)'}\n`
      )
    }
    process.stdout.write(
      report.picked
        ? `picked: ${report.picked.join(', ')}\n`
        : 'picked: none — run `activity week pick`\n'
    )
    return 0
  } finally {
    db?.close()
  }
}

export async function dispatchActivity(sub: string | undefined, args: string[]): Promise<number> {
  if (sub === 'week') return runWeek(args)
  if (sub !== 'digest') {
    process.stderr.write(
      `error: unknown activity subcommand "${sub ?? ''}" — expected "digest" or "week"\n\n${ACTIVITY_HELP}`
    )
    return 2
  }
  const parsed = parseArgs(args)
  if (typeof parsed === 'string') {
    process.stderr.write(`error: ${parsed}\n\n${ACTIVITY_HELP}`)
    return 2
  }

  const { resolveDataPaths } = await import('../../core/paths')
  const { runActivityDigest } = await import('../../core/domain/activity/activity-runner')
  const { default: Database } = await import('better-sqlite3')

  const { dbPath, artifactsDir } = resolveDataPaths()
  // Never create a DB as a side effect: a missing one just means no registered workspaces.
  const db = fs.existsSync(dbPath)
    ? new Database(dbPath, { readonly: true, fileMustExist: true })
    : null
  try {
    const result = runActivityDigest(
      { date: parsed.date, catchUp: parsed.catchUp },
      { artifactsDir, db, homeDir: os.homedir(), tz: parsed.tz }
    )
    for (const w of result.written) {
      process.stdout.write(`activity digest ${w.date}: ${w.prompts} prompts -> ${w.file}\n`)
    }
    if (result.kept.length) process.stdout.write(`kept existing: ${result.kept.join(', ')}\n`)
    if (result.pruned.length)
      process.stdout.write(`pruned (> retention): ${result.pruned.join(', ')}\n`)
    return 0
  } finally {
    db?.close()
  }
}
