import * as fs from 'fs'

// TASK-3129 — `choda-deck rules check <projectId>`: rules 1 and 2 of
// personal-operating-rules as one verdict. Exit 0 = pass, 3 = blocked, 2 = usage.
// /choda-autopilot §2.3 stops a run on exit 3; the SessionStart hook only warns.

export const RULES_HELP = `rules check <projectId> [--week YYYY-Www] [--json]
  Check rules 1 (one of the week's picked projects) and 2 (no green open PR, no
  IMPLEMENTED task waiting for a human check). Exit 0 pass, 3 blocked.
`

interface CheckArgs {
  projectId?: string
  week?: string
  json: boolean
}

function parseArgs(args: string[]): CheckArgs | string {
  const out: CheckArgs = { json: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--json') out.json = true
    else if (a === '--week') {
      const v = args[++i]
      if (!v) return '--week needs a value'
      out.week = v
    } else if (a.startsWith('--')) return `unknown option "${a}"`
    else if (out.projectId === undefined) out.projectId = a
    else return `unexpected argument "${a}"`
  }
  return out
}

export async function dispatchRules(sub: string | undefined, args: string[]): Promise<number> {
  if (sub !== 'check') {
    process.stderr.write(`error: unknown rules subcommand "${sub ?? ''}"\n\n${RULES_HELP}`)
    return 2
  }
  const parsed = parseArgs(args)
  if (typeof parsed === 'string' || !parsed.projectId) {
    const why = typeof parsed === 'string' ? parsed : 'name a project'
    process.stderr.write(`error: ${why}\n\n${RULES_HELP}`)
    return 2
  }

  const { isoWeekOf, isValidWeek } = await import('../../core/domain/activity/activity-week')
  const { localDate, DEFAULT_TZ } = await import('../../core/domain/activity/activity-digest')
  const week = parsed.week ?? isoWeekOf(localDate(Date.now(), DEFAULT_TZ))
  if (!isValidWeek(week)) {
    process.stderr.write(`error: --week must be an ISO week like 2026-W45 (got "${week}")\n`)
    return 2
  }
  const { resolveDataPaths } = await import('../../core/paths')
  const { rulesCheck } = await import('../../core/domain/activity/rules-check')
  const { default: Database } = await import('better-sqlite3')
  const { dbPath, artifactsDir } = resolveDataPaths()
  if (!fs.existsSync(dbPath)) {
    process.stderr.write(`error: no choda database at ${dbPath}\n`)
    return 2
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const result = rulesCheck(db, artifactsDir, parsed.projectId, week)
    if (parsed.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    else {
      process.stdout.write(`rules check ${result.projectId} ${result.week}: ${result.verdict}\n`)
      for (const r of result.reasons) process.stdout.write(`  ${r.message}\n`)
      for (const w of result.warnings) process.stdout.write(`  warning: ${w}\n`)
    }
    return result.verdict === 'blocked' ? 3 : 0
  } finally {
    db.close()
  }
}
