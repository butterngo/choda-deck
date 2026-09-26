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

export async function dispatchActivity(sub: string | undefined, args: string[]): Promise<number> {
  if (sub !== 'digest') {
    process.stderr.write(
      `error: unknown activity subcommand "${sub ?? ''}" — only "activity digest" is supported\n\n${ACTIVITY_HELP}`
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
